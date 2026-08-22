import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryAgentBankingAgentRepository,
  createInMemoryAgentFloatTopUpRepository,
  createInMemoryAgentTransactionRepository,
  createInMemoryAgentVoucherRepository
} from '../../database/repositories/agent-banking.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { StubMojaloopAdapter } from '../integrations/drivers/mojaloop.driver.js';
import { UsersService } from '../users/users.service.js';
import {
  AgentBankingService,
  PLATFORM_CASH_ACCOUNT,
  type ActorRef
} from './agent-banking.service.js';
import { StubOtpDriver, stubOtpCode } from './otp.driver.js';
import { DEV_VOUCHER_SECRET, resolveVoucherSecret, signVoucher } from './voucher-crypto.js';

/**
 * Stage 19 verification program — security hardening suite.
 * Covers the adapted insurance-platform prompt battery items that are
 * runnable against this codebase:
 *  A2 multi-tenant (cross-user) isolation on financial resources
 *  A4 idempotency: transport retries must never double-post
 *  A6 tamper/replay rejection (HMAC voucher forgery, OTP replay)
 *  B2/B3 failure discipline: redemptions pay out exactly once
 *  D1 double-entry invariant: every journal entry balances
 */

const ADMIN: ActorRef = { id: 'user-admin', roles: ['admin'] };

async function makeService(env: NodeJS.ProcessEnv = {}) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const users = new UsersService(createInMemoryUserRepository());
  const service = new AgentBankingService(
    createInMemoryAgentBankingAgentRepository(),
    createInMemoryAgentFloatTopUpRepository(),
    createInMemoryAgentVoucherRepository(),
    createInMemoryAgentTransactionRepository(),
    ledger,
    users,
    events,
    new StubOtpDriver(),
    new StubMojaloopAdapter(),
    env
  );
  const agentUser = await users.create({
    phone: '+2348000000001',
    fullName: 'Agent Amaka',
    roles: ['agent'],
    preferredLanguage: 'en'
  });
  const farmer = await users.create({
    phone: '+2348000000002',
    fullName: 'Farmer Femi',
    roles: ['farmer'],
    preferredLanguage: 'en'
  });
  const secondAgentUser = await users.create({
    phone: '+2348000000003',
    fullName: 'Agent Bello',
    roles: ['agent'],
    preferredLanguage: 'en'
  });
  const secondFarmer = await users.create({
    phone: '+2348000000004',
    fullName: 'Farmer Halima',
    roles: ['farmer'],
    preferredLanguage: 'en'
  });
  return { service, ledger, users, events, agentUser, farmer, secondAgentUser, secondFarmer };
}

function agentActor(user: User): ActorRef {
  return { id: user.id, roles: ['agent'] };
}

async function activeAgent(
  ctx: Awaited<ReturnType<typeof makeService>>,
  user: User,
  organisation = 'Kano Farmers Cooperative'
) {
  const agent = await ctx.service.registerAgent(
    { userId: user.id, organisation, dailyLimitKobo: 10_000_000, lowFloatThresholdKobo: 100_000 },
    ADMIN.id
  );
  await ctx.service.setAgentStatus(agent.id, 'ACTIVE', ADMIN.id);
  return ctx.service.getAgent(agent.id);
}

async function fundPlatformCash(ctx: Awaited<ReturnType<typeof makeService>>, amountKobo: number) {
  await ctx.ledger.ensureAccount({ code: 'platform:float_funding', type: 'equity' });
  await ctx.ledger.postEntry(
    {
      idempotencyKey: `fund-platform-cash:${amountKobo}`,
      description: 'Test float funding',
      postings: [
        { accountCode: PLATFORM_CASH_ACCOUNT, direction: 'debit', amountKobo },
        { accountCode: 'platform:float_funding', direction: 'credit', amountKobo }
      ]
    },
    ADMIN.id
  );
}

let secKeySeq = 0;

async function topUpFloat(
  ctx: Awaited<ReturnType<typeof makeService>>,
  agentId: string,
  amountKobo: number
) {
  secKeySeq += 1;
  const request = await ctx.service.requestTopUp(
    agentId,
    { amountKobo, idempotencyKey: `sec-topup-${secKeySeq}` },
    ADMIN
  );
  await ctx.service.decideTopUp(request.id, 'approve', ADMIN.id);
  return ctx.service.settleTopUp(request.id, ADMIN.id);
}

describe('A2 — cross-user isolation on financial resources', () => {
  it('agent B cannot issue vouchers from agent A’s float', async () => {
    const ctx = await makeService();
    const agentA = await activeAgent(ctx, ctx.agentUser);
    await activeAgent(ctx, ctx.secondAgentUser, 'Jos Cooperative');
    await expect(
      ctx.service.issueVoucher(
        agentA.id,
        { farmerId: ctx.farmer.id, amountKobo: 50_000, idempotencyKey: 'sec-v-1' },
        agentActor(ctx.secondAgentUser)
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('agent B cannot void agent A’s voucher', async () => {
    const ctx = await makeService();
    const agentA = await activeAgent(ctx, ctx.agentUser);
    const voucher = await ctx.service.issueVoucher(
      agentA.id,
      { farmerId: ctx.farmer.id, amountKobo: 50_000, idempotencyKey: 'sec-v-2' },
      agentActor(ctx.agentUser)
    );
    await expect(
      ctx.service.voidVoucher(voucher.id, agentActor(ctx.secondAgentUser))
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('farmer B cannot redeem farmer A’s voucher', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx, ctx.agentUser);
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 50_000, idempotencyKey: 'sec-v-3' },
      agentActor(ctx.agentUser)
    );
    await expect(
      ctx.service.redeemVoucher(voucher.id, voucher.signature, {
        id: ctx.secondFarmer.id,
        roles: ['farmer']
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('A6 — tamper and forgery rejection', () => {
  it('rejects a well-formed but forged HMAC signature', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx, ctx.agentUser);
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 50_000, idempotencyKey: 'sec-v-4' },
      agentActor(ctx.agentUser)
    );
    const forged = 'a'.repeat(64);
    await expect(
      ctx.service.redeemVoucher(voucher.id, forged, { id: ctx.farmer.id, roles: ['farmer'] })
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a signature valid for a tampered payload (raised amount)', async () => {
    const ctx = await makeService({ AGENT_VOUCHER_SECRET: 'hardening-test-secret' });
    const agent = await activeAgent(ctx, ctx.agentUser);
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 50_000, idempotencyKey: 'sec-v-5' },
      agentActor(ctx.agentUser)
    );
    // Attacker re-signs a raised-amount payload — it cannot match the stored signature.
    const tamperedSignature = signVoucher(
      {
        voucherId: voucher.id,
        agentId: voucher.agentId,
        farmerId: voucher.farmerId,
        amountKobo: voucher.amountKobo * 10,
        expiry: voucher.expiresAt,
        nonce: voucher.nonce
      },
      'hardening-test-secret'
    );
    await expect(
      ctx.service.redeemVoucher(voucher.id, tamperedSignature, {
        id: ctx.farmer.id,
        roles: ['farmer']
      })
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a malformed (non-HMAC) signature string', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx, ctx.agentUser);
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 50_000, idempotencyKey: 'sec-v-6' },
      agentActor(ctx.agentUser)
    );
    await expect(
      ctx.service.redeemVoucher(voucher.id, 'not-a-signature', {
        id: ctx.farmer.id,
        roles: ['farmer']
      })
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong OTP on cash-in (presence proof cannot be guessed)', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx, ctx.agentUser);
    await fundPlatformCash(ctx, 1_000_000);
    await topUpFloat(ctx, agent.id, 500_000);
    await expect(
      ctx.service.cashIn(
        agent.id,
        { farmerId: ctx.farmer.id, amountKobo: 10_000, otp: '000000-wrong', idempotencyKey: 'ci-otp-1' },
        agentActor(ctx.agentUser)
      )
    ).rejects.toBeInstanceOf(UnauthorizedException); // service wraps OtpVerificationError as 401
  });
});

describe('A4 / B2 — idempotency and exactly-once payout', () => {
  it('redeems a voucher exactly once; replay is a 409 with a single ledger posting', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx, ctx.agentUser);
    await fundPlatformCash(ctx, 1_000_000);
    await topUpFloat(ctx, agent.id, 500_000);
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 50_000, idempotencyKey: 'sec-v-7' },
      agentActor(ctx.agentUser)
    );
    const first = await ctx.service.redeemVoucher(voucher.id, voucher.signature, {
      id: ctx.farmer.id,
      roles: ['farmer']
    });
    expect(first.voucher.status).toBe('REDEEMED');
    await expect(
      ctx.service.redeemVoucher(voucher.id, voucher.signature, { id: ctx.farmer.id, roles: ['farmer'] })
    ).rejects.toBeInstanceOf(ConflictException);
    const entries = await ctx.ledger.listEntries({});
    const redemptionPostings = entries.filter(
      (entry) => entry.idempotencyKey === `voucher-redemption:${voucher.id}`
    );
    expect(redemptionPostings).toHaveLength(1);
    const wallet = await ctx.ledger.balance(`member:${ctx.farmer.id}:wallet`);
    expect(wallet.balanceKobo).toBe(50_000);
  });

  it('cash-in transport retry replays the original transaction — no double posting', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx, ctx.agentUser);
    await fundPlatformCash(ctx, 1_000_000);
    await topUpFloat(ctx, agent.id, 500_000);
    const input = {
      farmerId: ctx.farmer.id,
      amountKobo: 20_000,
      otp: stubOtpCode(ctx.farmer.id, 'ci-retry-1'),
      idempotencyKey: 'ci-retry-1'
    };
    const first = await ctx.service.cashIn(agent.id, input, agentActor(ctx.agentUser));
    const replay = await ctx.service.cashIn(agent.id, input, agentActor(ctx.agentUser));
    expect(replay.id).toBe(first.id);
    const entries = await ctx.ledger.listEntries({});
    const postings = entries.filter((entry) => entry.idempotencyKey === 'agent-tx:ci-retry-1');
    expect(postings).toHaveLength(1);
  });
});

describe('D1 — double-entry invariant', () => {
  it('rejects an unbalanced journal entry outright', async () => {
    const ctx = await makeService();
    await ctx.ledger.ensureAccount({ code: 'test:a', type: 'asset' });
    await ctx.ledger.ensureAccount({ code: 'test:b', type: 'equity' });
    await expect(
      ctx.ledger.postEntry(
        {
          idempotencyKey: 'unbalanced-1',
          description: 'Unbalanced attempt',
          postings: [
            { accountCode: 'test:a', direction: 'debit', amountKobo: 100_000 },
            { accountCode: 'test:b', direction: 'credit', amountKobo: 90_000 }
          ]
        },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('every entry posted across the full voucher lifecycle balances', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx, ctx.agentUser);
    await fundPlatformCash(ctx, 1_000_000);
    await topUpFloat(ctx, agent.id, 500_000);
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 50_000, idempotencyKey: 'sec-v-8' },
      agentActor(ctx.agentUser)
    );
    await ctx.service.redeemVoucher(voucher.id, voucher.signature, {
      id: ctx.farmer.id,
      roles: ['farmer']
    });
    const entries = await ctx.ledger.listEntries({});
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const debits = entry.postings
        .filter((posting) => posting.direction === 'debit')
        .reduce((sum, posting) => sum + posting.amountKobo, 0);
      const credits = entry.postings
        .filter((posting) => posting.direction === 'credit')
        .reduce((sum, posting) => sum + posting.amountKobo, 0);
      expect({ entry: entry.idempotencyKey, debits }).toEqual({
        entry: entry.idempotencyKey,
        debits: credits
      });
    }
  });
});

describe('B3 — fail-closed configuration contract', () => {
  it('refuses to sign vouchers in production without AGENT_VOUCHER_SECRET', () => {
    expect(() => resolveVoucherSecret({ NODE_ENV: 'production' })).toThrow(/AGENT_VOUCHER_SECRET/);
  });

  it('uses the configured secret in production and the labelled dev default otherwise', () => {
    expect(
      resolveVoucherSecret({ NODE_ENV: 'production', AGENT_VOUCHER_SECRET: 'live-secret' })
    ).toBe('live-secret');
    expect(resolveVoucherSecret({ NODE_ENV: 'development' })).toBe(DEV_VOUCHER_SECRET);
    expect(DEV_VOUCHER_SECRET).toContain('INSECURE');
  });
});
