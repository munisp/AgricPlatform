import { ConflictException } from '@nestjs/common';
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
  farmerWalletAccountCode,
  PLATFORM_CASH_ACCOUNT,
  type ActorRef
} from './agent-banking.service.js';
import { StubOtpDriver, stubOtpCode } from './otp.driver.js';

/**
 * WP-G11 (Stage 27, V2 idempotency-consistency audit): agent-banking
 * idempotency-record semantics for cash-in/out, float top-up requests and
 * voucher issuance. The canonical payload hash is stored with the client
 * key; the same key with a DIFFERENT payload fails closed with 409
 * IDEMPOTENCY_PAYLOAD_MISMATCH instead of silently replaying the original
 * record (the pre-fix behavior), and a same-key/same-payload retry still
 * replays exactly once.
 */

const ADMIN: ActorRef = { id: 'user-admin', roles: ['admin'] };

async function makeService() {
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
    {}
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
  return { service, ledger, users, agentUser, farmer };
}

type Ctx = Awaited<ReturnType<typeof makeService>>;

function agentActor(user: User): ActorRef {
  return { id: user.id, roles: ['agent'] };
}

async function activeAgent(ctx: Ctx) {
  const agent = await ctx.service.registerAgent(
    {
      userId: ctx.agentUser.id,
      organisation: 'Kano Farmers Cooperative',
      dailyLimitKobo: 10_000_000,
      lowFloatThresholdKobo: 100_000
    },
    ADMIN.id
  );
  await ctx.service.setAgentStatus(agent.id, 'ACTIVE', ADMIN.id);
  return ctx.service.getAgent(agent.id);
}

/** Funds platform:cash so top-up settlement passes the solvency guard. */
async function fundPlatformCash(ctx: Ctx, amountKobo: number) {
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

describe('WP-G11: agent cash transaction idempotency payload consistency', () => {
  it('cashIn same key + same payload replays the original transaction exactly once', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    const request = await ctx.service.requestTopUp(
      agent.id,
      { amountKobo: 2_000_000, idempotencyKey: 'wpg11-topup-seed' },
      ADMIN
    );
    await ctx.service.decideTopUp(request.id, 'approve', ADMIN.id);
    await ctx.service.settleTopUp(request.id, ADMIN.id);

    const input = {
      farmerId: ctx.farmer.id,
      amountKobo: 100_000,
      otp: stubOtpCode(ctx.farmer.id, 'ci-replay'),
      idempotencyKey: 'ci-replay'
    };
    const first = await ctx.service.cashIn(agent.id, input, agentActor(ctx.agentUser));
    const replay = await ctx.service.cashIn(agent.id, { ...input }, agentActor(ctx.agentUser));
    expect(replay.id).toBe(first.id);
    expect(replay.ledgerEntryId).toBe(first.ledgerEntryId);
    expect(replay.payloadHash).toBe(first.payloadHash);
    expect(await ctx.service.listTransactions({ agentId: agent.id })).toHaveLength(1);
    expect(
      (await ctx.ledger.balance(farmerWalletAccountCode(ctx.farmer.id))).balanceKobo
    ).toBe(100_000);
  });

  it('cashIn same key + different amount is a 409 IDEMPOTENCY_PAYLOAD_MISMATCH and moves no money', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    const request = await ctx.service.requestTopUp(
      agent.id,
      { amountKobo: 2_000_000, idempotencyKey: 'wpg11-topup-seed-2' },
      ADMIN
    );
    await ctx.service.decideTopUp(request.id, 'approve', ADMIN.id);
    await ctx.service.settleTopUp(request.id, ADMIN.id);

    await ctx.service.cashIn(
      agent.id,
      {
        farmerId: ctx.farmer.id,
        amountKobo: 100_000,
        otp: stubOtpCode(ctx.farmer.id, 'ci-mismatch'),
        idempotencyKey: 'ci-mismatch'
      },
      agentActor(ctx.agentUser)
    );
    await expect(
      ctx.service.cashIn(
        agent.id,
        {
          farmerId: ctx.farmer.id,
          amountKobo: 250_000, // same key, different payload
          otp: stubOtpCode(ctx.farmer.id, 'ci-mismatch'),
          idempotencyKey: 'ci-mismatch'
        },
        agentActor(ctx.agentUser)
      )
    ).rejects.toThrowError(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
    // The conflicting retry moved no money and recorded no transaction.
    expect(await ctx.service.listTransactions({ agentId: agent.id })).toHaveLength(1);
    expect(
      (await ctx.ledger.balance(farmerWalletAccountCode(ctx.farmer.id))).balanceKobo
    ).toBe(100_000);
    expect(
      (await ctx.ledger.listEntries({ referenceType: 'agent_banking_cash_in' })).length
    ).toBe(1);
  });

  it('the same key reused across cashIn vs cashOut (different type) is a 409', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    const request = await ctx.service.requestTopUp(
      agent.id,
      { amountKobo: 2_000_000, idempotencyKey: 'wpg11-topup-seed-3' },
      ADMIN
    );
    await ctx.service.decideTopUp(request.id, 'approve', ADMIN.id);
    await ctx.service.settleTopUp(request.id, ADMIN.id);

    await ctx.service.cashIn(
      agent.id,
      {
        farmerId: ctx.farmer.id,
        amountKobo: 100_000,
        otp: stubOtpCode(ctx.farmer.id, 'cross-type'),
        idempotencyKey: 'cross-type'
      },
      agentActor(ctx.agentUser)
    );
    await expect(
      ctx.service.cashOut(
        agent.id,
        {
          farmerId: ctx.farmer.id,
          amountKobo: 100_000,
          otp: stubOtpCode(ctx.farmer.id, 'cross-type'),
          idempotencyKey: 'cross-type'
        },
        agentActor(ctx.agentUser)
      )
    ).rejects.toThrowError(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
  });
});

describe('WP-G11: agent float top-up idempotency payload consistency', () => {
  it('same key + same payload replays; same key + different amount is a 409', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    const first = await ctx.service.requestTopUp(
      agent.id,
      { amountKobo: 500_000, idempotencyKey: 'topup-mismatch' },
      ADMIN
    );
    const replay = await ctx.service.requestTopUp(
      agent.id,
      { amountKobo: 500_000, idempotencyKey: 'topup-mismatch' },
      ADMIN
    );
    expect(replay.id).toBe(first.id);
    await expect(
      ctx.service.requestTopUp(
        agent.id,
        { amountKobo: 750_000, idempotencyKey: 'topup-mismatch' },
        ADMIN
      )
    ).rejects.toThrowError(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
    expect(await ctx.service.listTopUps({ agentId: agent.id })).toHaveLength(1);
  });

  it('the same key under a DIFFERENT agent is a 409', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await ctx.service.requestTopUp(
      agent.id,
      { amountKobo: 500_000, idempotencyKey: 'topup-cross-agent' },
      ADMIN
    );
    await expect(
      ctx.service.requestTopUp(
        'agent-other',
        { amountKobo: 500_000, idempotencyKey: 'topup-cross-agent' },
        ADMIN
      )
    ).rejects.toThrowError(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
  });
});

describe('WP-G11: agent voucher issuance idempotency payload consistency', () => {
  it('same key + same payload replays the original signed voucher exactly once', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const input = {
      farmerId: ctx.farmer.id,
      amountKobo: 50_000,
      expiresAt,
      idempotencyKey: 'voucher-replay'
    };
    const first = await ctx.service.issueVoucher(agent.id, input, agentActor(ctx.agentUser));
    const replay = await ctx.service.issueVoucher(agent.id, { ...input }, agentActor(ctx.agentUser));
    expect(replay.id).toBe(first.id);
    expect(replay.signature).toBe(first.signature);
    expect(replay.payloadHash).toBe(first.payloadHash);
    expect(await ctx.service.listVouchers({ agentId: agent.id })).toHaveLength(1);
  });

  it('a default-expiry retry fingerprints identically (expiresAt excluded after defaulting)', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    const input = {
      farmerId: ctx.farmer.id,
      amountKobo: 50_000,
      idempotencyKey: 'voucher-default-expiry'
    };
    const first = await ctx.service.issueVoucher(agent.id, input, agentActor(ctx.agentUser));
    // Same raw input seconds later: expiresAt defaulted differently inside,
    // but the fingerprint used the RAW input, so the retry replays.
    const replay = await ctx.service.issueVoucher(agent.id, { ...input }, agentActor(ctx.agentUser));
    expect(replay.id).toBe(first.id);
  });

  it('same key + different amount is a 409 IDEMPOTENCY_PAYLOAD_MISMATCH; no second voucher is signed', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 50_000, idempotencyKey: 'voucher-mismatch' },
      agentActor(ctx.agentUser)
    );
    await expect(
      ctx.service.issueVoucher(
        agent.id,
        { farmerId: ctx.farmer.id, amountKobo: 80_000, idempotencyKey: 'voucher-mismatch' },
        agentActor(ctx.agentUser)
      )
    ).rejects.toThrowError(ConflictException);
    await expect(
      ctx.service.issueVoucher(
        agent.id,
        { farmerId: ctx.farmer.id, amountKobo: 80_000, idempotencyKey: 'voucher-mismatch' },
        agentActor(ctx.agentUser)
      )
    ).rejects.toThrowError(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
    expect(await ctx.service.listVouchers({ agentId: agent.id })).toHaveLength(1);
  });

  it('same key + different farmer is a 409', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 50_000, idempotencyKey: 'voucher-farmer-mismatch' },
      agentActor(ctx.agentUser)
    );
    await expect(
      ctx.service.issueVoucher(
        agent.id,
        { farmerId: 'farmer-other', amountKobo: 50_000, idempotencyKey: 'voucher-farmer-mismatch' },
        agentActor(ctx.agentUser)
      )
    ).rejects.toThrowError(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
  });
});
