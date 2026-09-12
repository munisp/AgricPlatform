import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { LedgerBalance, Profile } from '@agric-platform/shared';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { createInMemoryFeatureFlagRepository } from '../../database/repositories/feature-flag.repository.js';
import { createInMemoryCommodityPriceRepository } from '../../database/repositories/commodity-price.repository.js';
import { createInMemoryIvrCallRepository } from '../../database/repositories/ivr-call.repository.js';
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
import type { DomainEventsService } from '../../core/domain-events.service.js';
import type { LedgerService } from '../finance/ledger.service.js';
import type { AdvisoryService } from '../advisory/advisory.service.js';
import type { LearningService } from '../learning/learning.service.js';
import type { ProfilesService } from '../profiles/profiles.service.js';
import { UsersService } from '../users/users.service.js';
import { hashSharedDevicePin } from '../auth/pin-session.service.js';
import { DEV_MSISDN_HASH_SALT, hashMsisdn } from '../voice/msisdn-crypto.js';
import { VoiceTellerService } from '../voice/voice-teller.service.js';
import { IvrService } from './ivr.service.js';

/**
 * Voice Teller × IVR integration tests (Stage 27, Innovation 6): full
 * Africa's Talking callback sessions across MULTIPLE handleCallback turns
 * (session resume), PIN gating, HMAC-only audit rows and the PIN-masking
 * of the persisted dtmf history.
 */

const ENABLED_ENV = {
  IVR_DRIVER: 'live',
  AT_API_KEY: 'test-key',
  AT_USERNAME: 'test-user'
} as unknown as NodeJS.ProcessEnv;

const CALLER = '+234809990001';
const DEVICE = 'device-ivr-1';
const PIN = '2468';

interface PublishedEvent {
  name: string;
  payload: unknown;
  actorId?: string;
}

function build(opts: { flagOn?: boolean } = {}) {
  const users = new UsersService(createInMemoryUserRepository());
  const profiles = {
    get: async (): Promise<Profile> => {
      throw new NotFoundException('no profile');
    }
  } as unknown as ProfilesService;
  const advisory = { all: async () => [] } as unknown as AdvisoryService;
  const learning = { enrolmentsForUser: async () => [] } as unknown as LearningService;
  const calls = createInMemoryIvrCallRepository();
  const prices = createInMemoryCommodityPriceRepository([]);
  const pins = createInMemoryPinProfileRepository();
  const sessions = createInMemoryVoiceIntentSessionRepository();
  const savings = createInMemoryCreditSavingsAccountRepository();
  const published: PublishedEvent[] = [];
  const events = {
    publish: async (name: string, payload: unknown, actorId?: string) => {
      published.push({ name, payload, actorId });
    }
  } as unknown as DomainEventsService;
  const ledger = {
    balance: async (accountCode: string): Promise<LedgerBalance> => ({
      accountCode,
      debitsKobo: 0,
      creditsKobo: 0,
      balanceKobo: 0
    })
  } as unknown as LedgerService;
  const flags = new FeatureFlagsService(
    createInMemoryFeatureFlagRepository(
      opts.flagOn === false
        ? []
        : [
            {
              key: 'voice-teller',
              enabled: true,
              roleAllowlist: [],
              percentage: 100,
              description: 'test'
            }
          ]
    )
  );
  const teller = new VoiceTellerService(
    users,
    ledger,
    flags,
    new TelemetryService(),
    events,
    pins,
    sessions,
    savings,
    createInMemoryCreditLoanRepository(),
    createInMemoryCreditRepaymentRepository(),
    createInMemoryAgentBankingAgentRepository(),
    createInMemoryVslaMemberRepository(),
    createInMemoryInputVoucherRepository(),
    ENABLED_ENV
  );
  const ivr = new IvrService(users, profiles, advisory, learning, calls, prices, ENABLED_ENV, teller);
  return { ivr, users, pins, sessions, savings, calls, published };
}

async function registered(h: ReturnType<typeof build>) {
  const user = await h.users.create({
    phone: CALLER,
    fullName: 'Ivr Farmer',
    roles: ['farmer'],
    preferredLanguage: 'en'
  });
  await h.pins.save({
    deviceToken: DEVICE,
    userId: user.id,
    pinHash: hashSharedDevicePin(DEVICE, user.id, PIN),
    attempts: 0,
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  return user;
}

describe('IVR session resume across callbacks (Voice Teller)', () => {
  it('walks opening → account menu → PIN → spoken savings balance over 4 callbacks', async () => {
    const h = build();
    const user = await registered(h);
    await h.savings.create({
      id: 'sav-1',
      userId: user.id,
      balanceKobo: 765400,
      updatedAt: '2026-01-01T00:00:00.000Z'
    });

    const opening = await h.ivr.handleCallback({ sessionId: 'call-1', callerNumber: CALLER });
    expect(opening).toContain('Press 5 for your account services.');

    const menu = await h.ivr.handleCallback({
      sessionId: 'call-1',
      callerNumber: CALLER,
      dtmfDigits: '5',
      isActive: '1'
    });
    expect(menu).toContain('Account services.');

    const pinPrompt = await h.ivr.handleCallback({
      sessionId: 'call-1',
      callerNumber: CALLER,
      dtmfDigits: '1',
      isActive: '1'
    });
    expect(pinPrompt).toContain('Please enter your 4 digit security PIN.');

    const answer = await h.ivr.handleCallback({
      sessionId: 'call-1',
      callerNumber: CALLER,
      dtmfDigits: PIN,
      isActive: '1'
    });
    expect(answer).toContain('Your savings balance is 7,654 naira.');

    // Session record: outcome completed, PIN never in the dtmf history.
    const record = await h.calls.findById('call-1');
    expect(record?.outcome).toBe('completed');
    expect(record?.dtmfHistory).toBe('5*1*####');
    expect(record?.dtmfHistory).not.toContain(PIN);
    expect(JSON.stringify(record)).not.toContain(PIN);

    // Audit row: HMAC-only MSISDN, answered + started events in order.
    const rows = await h.sessions.find({ userId: user.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].msisdnHmac).toBe(hashMsisdn(CALLER, DEV_MSISDN_HASH_SALT));
    expect(h.published.map((e) => e.name)).toEqual([
      'voice.intent.started',
      'voice.intent.answered'
    ]);
  });

  it('wrong PIN re-prompts in-call and a correct PIN on the next callback still answers', async () => {
    const h = build();
    const user = await registered(h);
    await h.savings.create({
      id: 'sav-1',
      userId: user.id,
      balanceKobo: 100,
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    await h.ivr.handleCallback({ sessionId: 'call-2', callerNumber: CALLER });
    await h.ivr.handleCallback({ sessionId: 'call-2', callerNumber: CALLER, dtmfDigits: '5' });
    await h.ivr.handleCallback({ sessionId: 'call-2', callerNumber: CALLER, dtmfDigits: '1' });
    const wrong = await h.ivr.handleCallback({
      sessionId: 'call-2',
      callerNumber: CALLER,
      dtmfDigits: '0000'
    });
    expect(wrong).toContain('That PIN is not correct.');
    expect(wrong).toContain('Please enter your 4 digit PIN again.');
    const right = await h.ivr.handleCallback({
      sessionId: 'call-2',
      callerNumber: CALLER,
      dtmfDigits: PIN
    });
    expect(right).toContain('Your savings balance is 1 naira.');
    expect((await h.pins.find(DEVICE, user.id))?.attempts).toBe(0);
  });

  it('flag OFF keeps the account menu invisible and unreachable end-to-end', async () => {
    const h = build({ flagOn: false });
    await registered(h);
    const opening = await h.ivr.handleCallback({ sessionId: 'call-3', callerNumber: CALLER });
    expect(opening).not.toContain('account services');
    const five = await h.ivr.handleCallback({
      sessionId: 'call-3',
      callerNumber: CALLER,
      dtmfDigits: '5'
    });
    expect(five).toContain('not a valid choice');
    expect(await h.sessions.find({})).toHaveLength(0);
  });

  it('unregistered callers are turned away at the account menu', async () => {
    const h = build();
    await h.ivr.handleCallback({ sessionId: 'call-4', callerNumber: CALLER });
    const five = await h.ivr.handleCallback({
      sessionId: 'call-4',
      callerNumber: CALLER,
      dtmfDigits: '5'
    });
    expect(five).toContain('not registered');
    expect(await h.sessions.find({})).toHaveLength(0);
  });

  it('escalation from the account menu publishes voice.intent.escalated', async () => {
    const h = build();
    await registered(h);
    await h.ivr.handleCallback({ sessionId: 'call-5', callerNumber: CALLER });
    await h.ivr.handleCallback({ sessionId: 'call-5', callerNumber: CALLER, dtmfDigits: '5' });
    const esc = await h.ivr.handleCallback({
      sessionId: 'call-5',
      callerNumber: CALLER,
      dtmfDigits: '0'
    });
    expect(esc).toContain('Enqueue');
    expect(h.published.map((e) => e.name)).toEqual(['voice.intent.escalated']);
  });
});
