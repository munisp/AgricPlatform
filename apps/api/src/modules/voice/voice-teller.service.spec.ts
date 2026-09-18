import { describe, expect, it } from 'vitest';
import type { LedgerBalance } from '@agric-platform/shared';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { createInMemoryFeatureFlagRepository } from '../../database/repositories/feature-flag.repository.js';
import { createInMemoryPinProfileRepository } from '../../database/repositories/pin-profile.repository.js';
import { createInMemoryVoiceIntentSessionRepository } from '../../database/repositories/voice-intent.repository.js';
import {
  createInMemoryCreditLoanRepository,
  createInMemoryCreditRepaymentRepository,
  createInMemoryCreditSavingsAccountRepository
} from '../../database/repositories/credit-suite.repository.js';
import { createInMemoryAgentBankingAgentRepository } from '../../database/repositories/agent-banking.repository.js';
import { createInMemoryVslaMemberRepository } from '../../database/repositories/vsla-carbon.repository.js';
import { createInMemoryInputVoucherRepository } from '../../database/repositories/input-vouchers.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { hashSharedDevicePin } from '../auth/pin-session.service.js';
import type { DomainEventsService } from '../../core/domain-events.service.js';
import type { LedgerService } from '../finance/ledger.service.js';
import { UsersService } from '../users/users.service.js';
import { hashMsisdn, DEV_MSISDN_HASH_SALT } from './msisdn-crypto.js';
import {
  VOICE_TELLER_PIN_LOCKOUT_MS,
  VOICE_TELLER_PIN_MAX_ATTEMPTS,
  VoiceTellerService
} from './voice-teller.service.js';

/**
 * Voice Teller service tests (Stage 27, Innovation 6): PIN-failure lockout
 * (reused shared-device PIN policy), live read-model answers, fail-closed
 * unavailable on read failure, HMAC-only audit rows, and the event trail.
 */

const CALLER = '+2348012345678';
const DEVICE = 'device-1';
const PIN = '4321';

const FLAG_ON = [
  { key: 'voice-teller', enabled: true, roleAllowlist: [], percentage: 100, description: 'test' }
];

interface PublishedEvent {
  name: string;
  payload: unknown;
  actorId?: string;
}

function build(opts: { flagOn?: boolean; ledgerBalances?: Record<string, number>; throwOn?: string[] } = {}) {
  const users = new UsersService(createInMemoryUserRepository());
  const pins = createInMemoryPinProfileRepository();
  const sessions = createInMemoryVoiceIntentSessionRepository();
  const savings = createInMemoryCreditSavingsAccountRepository();
  const loans = createInMemoryCreditLoanRepository();
  const repayments = createInMemoryCreditRepaymentRepository();
  const agents = createInMemoryAgentBankingAgentRepository();
  const vslaMembers = createInMemoryVslaMemberRepository();
  const vouchers = createInMemoryInputVoucherRepository();
  const published: PublishedEvent[] = [];
  const events = {
    publish: async (name: string, payload: unknown, actorId?: string) => {
      published.push({ name, payload, actorId });
    }
  } as unknown as DomainEventsService;
  const ledger = {
    balance: async (accountCode: string): Promise<LedgerBalance> => {
      if (opts.throwOn?.some((prefix) => accountCode.startsWith(prefix))) {
        throw new Error(`read model unavailable for ${accountCode}`);
      }
      return {
        accountCode,
        debitsKobo: 0,
        creditsKobo: 0,
        balanceKobo: opts.ledgerBalances?.[accountCode] ?? 0
      };
    }
  } as unknown as LedgerService;
  const flags = new FeatureFlagsService(
    createInMemoryFeatureFlagRepository(opts.flagOn === false ? [] : FLAG_ON)
  );
  const service = new VoiceTellerService(
    users,
    ledger,
    flags,
    new TelemetryService(),
    events,
    pins,
    sessions,
    savings,
    loans,
    repayments,
    agents,
    vslaMembers,
    vouchers,
    {} as NodeJS.ProcessEnv
  );
  return {
    service,
    users,
    pins,
    sessions,
    savings,
    loans,
    repayments,
    agents,
    vslaMembers,
    vouchers,
    published,
    ledger
  };
}

async function registeredFarmer(harness: ReturnType<typeof build>, phone = CALLER) {
  const user = await harness.users.create({
    phone,
    fullName: 'Teller Farmer',
    roles: ['farmer'],
    preferredLanguage: 'en'
  });
  await harness.pins.save({
    deviceToken: DEVICE,
    userId: user.id,
    pinHash: hashSharedDevicePin(DEVICE, user.id, PIN),
    attempts: 0,
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  return user;
}

function pinInput(intent: Parameters<VoiceTellerService['resolvePinTurn']>[0]['intent'], pin = PIN) {
  return { sessionId: 'call-1', callerNumber: CALLER, intent, pin, strikes: 0, locale: 'en' };
}

describe('PIN-gated intent answers', () => {
  it('answers the savings balance after a correct PIN and records HMAC-only', async () => {
    const h = build();
    const user = await registeredFarmer(h);
    await h.savings.create({
      id: 'sav-1',
      userId: user.id,
      balanceKobo: 123456,
      updatedAt: '2026-01-01T00:00:00.000Z'
    });

    const turn = await h.service.resolvePinTurn(pinInput('balance.savings'));

    expect(turn.end).toBe(true);
    expect(turn.outcome).toBe('completed');
    expect(turn.actions[0]).toEqual({
      type: 'say',
      text: 'Your savings balance is 1,234 naira and 56 kobo.'
    });

    const rows = await h.sessions.find({ userId: user.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe('ok');
    expect(rows[0].intent).toBe('balance.savings');
    expect(rows[0].channel).toBe('ivr');
    // Privacy invariant: HMAC-only, never the plaintext MSISDN.
    expect(rows[0].msisdnHmac).toBe(hashMsisdn(CALLER, DEV_MSISDN_HASH_SALT));
    expect(rows[0].msisdnHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain(CALLER);
    expect(h.published.map((e) => e.name)).toEqual(['voice.intent.answered']);
  });

  it('answers the agent float balance from the ledger sub-account', async () => {
    const h = build({ ledgerBalances: { 'agent:agent-1:float': 2500000 } });
    const user = await registeredFarmer(h);
    await h.agents.create({
      id: 'agent-1',
      userId: user.id,
      organisation: 'Coop',
      status: 'ACTIVE',
      floatAccountCode: 'agent:agent-1:float',
      commissionAccountCode: 'agent:agent-1:commission_payable',
      dailyLimitKobo: 100000000,
      lowFloatThresholdKobo: 2000000,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    const turn = await h.service.resolvePinTurn(pinInput('balance.float'));
    expect(turn.actions[0]).toEqual({
      type: 'say',
      text: 'Your agent float balance is 25,000 naira.'
    });
  });

  it('tells non-agents there is no float (honest answer, still ok)', async () => {
    const h = build();
    await registeredFarmer(h);
    const turn = await h.service.resolvePinTurn(pinInput('balance.float'));
    expect(turn.end).toBe(true);
    expect(turn.actions[0]).toEqual({
      type: 'say',
      text: 'This number is not registered as an agent, so there is no float account.'
    });
    expect((await h.sessions.find({}))[0].result).toBe('ok');
  });

  it('answers the next loan installment (earliest pending across active loans)', async () => {
    const h = build();
    const user = await registeredFarmer(h);
    await h.loans.create({
      id: 'loan-1',
      applicantUserId: user.id,
      productId: 'prod-1',
      principalKobo: 10000000,
      status: 'repaying',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    await h.repayments.create({
      id: 'rep-2',
      loanId: 'loan-1',
      sequence: 2,
      dueAt: '2026-11-05T00:00:00.000Z',
      amountKobo: 1575050,
      status: 'pending'
    });
    await h.repayments.create({
      id: 'rep-1',
      loanId: 'loan-1',
      sequence: 1,
      dueAt: '2026-10-05T00:00:00.000Z',
      amountKobo: 1575050,
      status: 'pending'
    });
    await h.repayments.create({
      id: 'rep-0',
      loanId: 'loan-1',
      sequence: 0,
      dueAt: '2026-09-05T00:00:00.000Z',
      amountKobo: 1575050,
      status: 'paid'
    });
    const turn = await h.service.resolvePinTurn(pinInput('loan.next_installment'));
    expect(turn.actions[0]).toEqual({
      type: 'say',
      text: 'Your next loan installment is 15,750 naira and 50 kobo, due on 5 October 2026.'
    });
  });

  it('answers the VSLA position summed across active memberships', async () => {
    // The ledger stub keys balances by account code; the member savings
    // account code is vsla:<groupId>:member:<userId>.
    const h = build();
    const user = await registeredFarmer(h);
    for (const groupId of ['g1', 'g2']) {
      await h.vslaMembers.create({
        id: `m-${groupId}`,
        groupId,
        userId: user.id,
        role: 'member',
        status: 'ACTIVE',
        joinedAt: '2026-01-01T00:00:00.000Z'
      });
    }
    // Exited memberships are excluded from the position.
    await h.vslaMembers.create({
      id: 'm-g3',
      groupId: 'g3',
      userId: user.id,
      role: 'member',
      status: 'EXITED',
      joinedAt: '2025-01-01T00:00:00.000Z',
      exitedAt: '2025-06-01T00:00:00.000Z'
    });
    // Same repos, ledger keyed by the member account codes (user.id is
    // only known after creation, so the stub is swapped post-setup).
    const balances: Record<string, number> = {
      [`vsla:g1:member:${user.id}`]: 300000,
      [`vsla:g2:member:${user.id}`]: 500000,
      [`vsla:g3:member:${user.id}`]: 999999
    };
    const published: PublishedEvent[] = [];
    const service = new VoiceTellerService(
      h.users,
      {
        balance: async (accountCode: string): Promise<LedgerBalance> => ({
          accountCode,
          debitsKobo: 0,
          creditsKobo: 0,
          balanceKobo: balances[accountCode] ?? 0
        })
      } as unknown as LedgerService,
      new FeatureFlagsService(createInMemoryFeatureFlagRepository(FLAG_ON)),
      new TelemetryService(),
      {
        publish: async (name: string, payload: unknown, actorId?: string) => {
          published.push({ name, payload, actorId });
        }
      } as unknown as DomainEventsService,
      h.pins,
      h.sessions,
      h.savings,
      h.loans,
      h.repayments,
      h.agents,
      h.vslaMembers,
      h.vouchers,
      {} as NodeJS.ProcessEnv
    );
    const resolved = await service.resolvePinTurn(pinInput('vsla.position'));
    expect(resolved.actions[0]).toEqual({
      type: 'say',
      text: 'Your V S L A savings position across 2 groups is 8,000 naira.'
    });
  });

  it('answers the latest voucher status', async () => {
    const h = build();
    const user = await registeredFarmer(h);
    await h.vouchers.create({
      id: 'v-old',
      programmeId: 'prog-1',
      beneficiaryId: 'ben-1',
      farmerId: user.id,
      amountKobo: 300000,
      status: 'EXPIRED',
      idempotencyKey: 'k1',
      expiresAt: '2026-12-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    await h.vouchers.create({
      id: 'v-new',
      programmeId: 'prog-1',
      beneficiaryId: 'ben-1',
      farmerId: user.id,
      amountKobo: 500000,
      status: 'REDEEMED',
      idempotencyKey: 'k2',
      expiresAt: '2026-12-01T00:00:00.000Z',
      createdAt: '2026-02-01T00:00:00.000Z'
    });
    const turn = await h.service.resolvePinTurn(pinInput('voucher.status'));
    expect(turn.actions[0]).toEqual({
      type: 'say',
      text: 'Your most recent input voucher for 5,000 naira is already redeemed.'
    });
  });
});

describe('PIN failure policy (shared-device PIN reuse)', () => {
  it('wrong PIN re-prompts and counts an atomic attempt; no session row', async () => {
    const h = build();
    const user = await registeredFarmer(h);
    const turn = await h.service.resolvePinTurn(pinInput('balance.savings', '9999'));
    expect(turn.end).toBe(false);
    expect(turn.state.menu).toBe('account_pin');
    expect(turn.state.strikes).toBe(1);
    expect(turn.state.pendingIntent).toBe('balance.savings');
    expect(turn.actions[0]).toEqual({ type: 'say', text: 'That PIN is not correct.' });
    expect((await h.pins.find(DEVICE, user.id))?.attempts).toBe(1);
    expect(await h.sessions.find({})).toHaveLength(0);
    expect(h.published).toHaveLength(0);
  });

  it('locks the profile after 5 wrong PINs and rejects even the correct PIN for 15 minutes', async () => {
    const h = build();
    const user = await registeredFarmer(h);
    for (let attempt = 1; attempt <= VOICE_TELLER_PIN_MAX_ATTEMPTS - 1; attempt += 1) {
      const turn = await h.service.resolvePinTurn(pinInput('balance.savings', '9999'));
      expect(turn.end).toBe(false); // still re-prompting
    }
    const fifth = await h.service.resolvePinTurn(pinInput('balance.savings', '9999'));
    expect(fifth.end).toBe(true);
    expect(fifth.actions[0]).toEqual({ type: 'say', text: expect.stringContaining('locked') });

    const profile = await h.pins.find(DEVICE, user.id);
    expect(profile?.attempts).toBe(0);
    expect(profile?.lockedUntil).toBeDefined();
    const lockMs = new Date(profile?.lockedUntil ?? '').getTime() - Date.now();
    expect(lockMs).toBeGreaterThan(VOICE_TELLER_PIN_LOCKOUT_MS - 60_000);

    // Even the correct PIN is rejected while locked.
    const locked = await h.service.resolvePinTurn(pinInput('balance.savings', PIN));
    expect(locked.end).toBe(true);
    expect(locked.actions[0]).toEqual({ type: 'say', text: expect.stringContaining('locked') });
    expect(await h.sessions.find({})).toHaveLength(0);
  });

  it('scopes lockout per device profile: a locked profile does not deny the account (L-11)', async () => {
    const h = build();
    const user = await registeredFarmer(h);
    // Same PIN on a second family device (salted per device token).
    const DEVICE2 = 'device-token-bbbb';
    await h.pins.save({
      deviceToken: DEVICE2,
      userId: user.id,
      pinHash: hashSharedDevicePin(DEVICE2, user.id, PIN),
      attempts: 0,
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    // Lock the first profile (e.g. after a dial-in attacker's wrong guesses).
    await h.pins.update(DEVICE, user.id, {
      attempts: 0,
      lockedUntil: new Date(Date.now() + VOICE_TELLER_PIN_LOCKOUT_MS).toISOString()
    });
    // The account is NOT locked: the correct PIN still verifies through the
    // unlocked device profile.
    const turn = await h.service.resolvePinTurn(pinInput('balance.savings', PIN));
    expect(turn.end).toBe(true);
    expect(turn.actions[0]).not.toEqual({ type: 'say', text: expect.stringContaining('locked') });
    // A wrong PIN re-prompts rather than reporting an account-wide lock…
    const wrong = await h.service.resolvePinTurn(pinInput('balance.savings', '9999'));
    expect(wrong.end).toBe(false);
    expect(wrong.actions[0]).toEqual({ type: 'say', text: 'That PIN is not correct.' });
    // …until EVERY profile is locked.
    await h.pins.update(DEVICE2, user.id, {
      attempts: 0,
      lockedUntil: new Date(Date.now() + VOICE_TELLER_PIN_LOCKOUT_MS).toISOString()
    });
    const denied = await h.service.resolvePinTurn(pinInput('balance.savings', PIN));
    expect(denied.end).toBe(true);
    expect(denied.actions[0]).toEqual({ type: 'say', text: expect.stringContaining('locked') });
  });

  it('a correct PIN clears prior failed attempts', async () => {
    const h = build();
    const user = await registeredFarmer(h);
    await h.service.resolvePinTurn(pinInput('balance.savings', '9999'));
    await h.service.resolvePinTurn(pinInput('balance.savings', '9999'));
    const turn = await h.service.resolvePinTurn(pinInput('balance.savings', PIN));
    expect(turn.end).toBe(true);
    expect((await h.pins.find(DEVICE, user.id))?.attempts).toBe(0);
  });

  it('ends the call after 3 in-call wrong PINs', async () => {
    const h = build();
    await registeredFarmer(h);
    const turn = await h.service.resolvePinTurn({
      ...pinInput('balance.savings', '9999'),
      strikes: 2
    });
    expect(turn.end).toBe(true);
    expect(turn.outcome).toBe('abandoned');
  });

  it('a user with no PIN profile is told to set one up', async () => {
    const h = build();
    await h.users.create({
      phone: CALLER,
      fullName: 'No Pin Farmer',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    const turn = await h.service.resolvePinTurn(pinInput('balance.savings'));
    expect(turn.end).toBe(true);
    expect(turn.actions[0]).toEqual({
      type: 'say',
      text: expect.stringContaining('not set up a security PIN')
    });
  });
});

describe('fail-closed behavior', () => {
  it('read-model failure speaks "unavailable", records result=unavailable, publishes voice.intent.failed', async () => {
    const h = build({ throwOn: ['agent:'] });
    const user = await registeredFarmer(h);
    await h.agents.create({
      id: 'agent-1',
      userId: user.id,
      organisation: 'Coop',
      status: 'ACTIVE',
      floatAccountCode: 'agent:agent-1:float',
      commissionAccountCode: 'agent:agent-1:commission_payable',
      dailyLimitKobo: 100000000,
      lowFloatThresholdKobo: 2000000,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    const turn = await h.service.resolvePinTurn(pinInput('balance.float'));
    expect(turn.end).toBe(true);
    expect(turn.actions[0]).toEqual({
      type: 'say',
      text: 'That service is unavailable right now. Please try again later.'
    });
    const rows = await h.sessions.find({ userId: user.id });
    expect(rows[0].result).toBe('unavailable');
    expect(h.published.map((e) => e.name)).toEqual(['voice.intent.failed']);
  });

  it('flag OFF answers unavailable without touching read models', async () => {
    const h = build({ flagOn: false });
    await registeredFarmer(h);
    const turn = await h.service.resolvePinTurn(pinInput('balance.savings'));
    expect(turn.end).toBe(true);
    expect(turn.actions[0]).toEqual({
      type: 'say',
      text: 'That service is unavailable right now. Please try again later.'
    });
    expect(await h.sessions.find({})).toHaveLength(0);
  });

  it('unknown caller hears the registration prompt; nothing recorded', async () => {
    const h = build();
    const turn = await h.service.resolvePinTurn(pinInput('balance.savings'));
    expect(turn.end).toBe(true);
    expect(turn.actions[0]).toEqual({
      type: 'say',
      text: expect.stringContaining('not registered')
    });
    expect(await h.sessions.find({})).toHaveLength(0);
  });
});

describe('catalog', () => {
  it('lists the four-plus-float intents with DTMF keys and read models', () => {
    const h = build();
    const catalog = h.service.catalog(true) as {
      flag: string;
      intents: Array<{ intent: string; dtmf: string }>;
    };
    expect(catalog.flag).toBe('voice-teller');
    expect(catalog.intents.map((i) => i.intent).sort()).toEqual([
      'balance.float',
      'balance.savings',
      'loan.next_installment',
      'voucher.status',
      'vsla.position'
    ]);
  });
});
