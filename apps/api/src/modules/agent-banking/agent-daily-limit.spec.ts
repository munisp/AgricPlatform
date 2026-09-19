import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  farmerWalletAccountCode,
  type ActorRef
} from './agent-banking.service.js';
import { StubOtpDriver, stubOtpCode } from './otp.driver.js';

/**
 * Stage 27 WP-G2 (V2 funds-atomicity audit, A1-7): the agent daily cash cap
 * is enforced by an atomic counter reservation INSIDE the ledger posting
 * transaction, not by a check-then-act sum. These tests run against the
 * in-memory repositories, whose reservation check-and-increment is
 * synchronous (no await between read and write), so Promise.all fan-out
 * exercises the same interleaving that defeated the old code: every request
 * observed the same pre-sum and every request posted.
 *
 * The pg twin (test/pg/agent-daily-limit.pg.spec.ts) proves the SQL shape
 * via a query spy and runs the true-concurrency variant under DATABASE_URL.
 */

const ADMIN: ActorRef = { id: 'user-admin', roles: ['admin'] };

async function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const ledgerAccounts = createInMemoryLedgerAccountRepository();
  const ledger = new LedgerService(
    events,
    ledgerAccounts,
    createInMemoryLedgerEntryRepository()
  );
  const users = new UsersService(createInMemoryUserRepository());
  const service = new AgentBankingService(
    createInMemoryAgentBankingAgentRepository(ledgerAccounts),
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

async function activeAgent(ctx: Ctx, dailyLimitKobo: number) {
  const agent = await ctx.service.registerAgent(
    {
      userId: ctx.agentUser.id,
      organisation: 'Kano Farmers Cooperative',
      dailyLimitKobo,
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

let topUpKeySeq = 0;
async function topUpFloat(ctx: Ctx, agentId: string, amountKobo: number) {
  topUpKeySeq += 1;
  const request = await ctx.service.requestTopUp(
    agentId,
    { amountKobo, idempotencyKey: `wp-g2-topup-${topUpKeySeq}` },
    ADMIN
  );
  await ctx.service.decideTopUp(request.id, 'approve', ADMIN.id);
  return ctx.service.settleTopUp(request.id, ADMIN.id);
}

/**
 * Seeds the farmer wallet DIRECTLY through the ledger (not via cashIn, which
 * would consume the daily cap under test).
 */
async function seedFarmerWallet(ctx: Ctx, amountKobo: number) {
  const walletCode = farmerWalletAccountCode(ctx.farmer.id);
  await ctx.ledger.ensureAccount({ code: walletCode, type: 'asset', ownerId: ctx.farmer.id });
  await ctx.ledger.postEntry(
    {
      idempotencyKey: `seed-wallet:${amountKobo}:${topUpKeySeq}:${Math.random()}`,
      description: 'Test wallet funding',
      postings: [
        { accountCode: walletCode, direction: 'debit', amountKobo },
        { accountCode: PLATFORM_CASH_ACCOUNT, direction: 'credit', amountKobo }
      ]
    },
    ADMIN.id
  );
}

function cashOutInput(ctx: Ctx, key: string, amountKobo: number) {
  return {
    farmerId: ctx.farmer.id,
    amountKobo,
    otp: stubOtpCode(ctx.farmer.id, key),
    idempotencyKey: key
  };
}

function cashInInput(ctx: Ctx, key: string, amountKobo: number) {
  return cashOutInput(ctx, key, amountKobo);
}

describe('AgentBankingService — atomic daily cash limit (WP-G2, audit A1-7)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps N concurrent cash-out requests at floor(cap/amount) — the cap is never exceeded', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx, 600_000);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    await seedFarmerWallet(ctx, 5_000_000);

    // 5 concurrent cash-outs of 200_000 against a 600_000 cap: each is under
    // the cap alone but together they sum to 1_000_000. The old
    // check-then-act code let ALL of them through; the atomic reservation
    // must admit exactly floor(600_000 / 200_000) = 3.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        ctx.service.cashOut(agent.id, cashOutInput(ctx, `co-race-${i}`, 200_000), agentActor(ctx.agentUser))
      )
    );
    const succeeded = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(succeeded).toHaveLength(3);
    expect(rejected).toHaveLength(2);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);
      expect(String((result as PromiseRejectedResult).reason)).toContain('Agent daily limit exceeded');
    }

    // Exact cap consumed, never exceeded.
    const todays = await ctx.service.listTransactions({ agentId: agent.id });
    const used = todays.reduce((sum, tx) => sum + tx.amountKobo, 0);
    expect(used).toBe(600_000);

    // A further request — even a small one — is rejected.
    await expect(
      ctx.service.cashOut(agent.id, cashOutInput(ctx, 'co-race-extra', 100_000), agentActor(ctx.agentUser))
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cash-in and cash-out share ONE cap, enforced atomically across concurrent mixed requests', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx, 600_000);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    await seedFarmerWallet(ctx, 5_000_000);

    await ctx.service.cashIn(agent.id, cashInInput(ctx, 'ci-shared-1', 400_000), agentActor(ctx.agentUser));

    // 400_000 already used; two concurrent 200_000 cash-outs — only one fits.
    const results = await Promise.allSettled([
      ctx.service.cashOut(agent.id, cashOutInput(ctx, 'co-shared-1', 200_000), agentActor(ctx.agentUser)),
      ctx.service.cashOut(agent.id, cashOutInput(ctx, 'co-shared-2', 200_000), agentActor(ctx.agentUser))
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const todays = await ctx.service.listTransactions({ agentId: agent.id });
    expect(todays.reduce((sum, tx) => sum + tx.amountKobo, 0)).toBe(600_000);
  });

  it('a failed posting does NOT consume the daily limit', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx, 600_000);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);

    // Cash-out against an EMPTY farmer wallet: the reservation is taken
    // inside the posting transaction, the solvency guard then rejects the
    // posting, and the rollback must release the reservation.
    await expect(
      ctx.service.cashOut(agent.id, cashOutInput(ctx, 'co-fail-1', 200_000), agentActor(ctx.agentUser))
    ).rejects.toBeInstanceOf(BadRequestException);

    // If the failed attempt had leaked its reservation, only TWO of these
    // three 200_000 cash-outs would fit under the 600_000 cap.
    await seedFarmerWallet(ctx, 5_000_000);
    for (let i = 0; i < 3; i += 1) {
      await ctx.service.cashOut(agent.id, cashOutInput(ctx, `co-ok-${i}`, 200_000), agentActor(ctx.agentUser));
    }
    await expect(
      ctx.service.cashOut(agent.id, cashOutInput(ctx, 'co-over', 200_000), agentActor(ctx.agentUser))
    ).rejects.toBeInstanceOf(BadRequestException);
    const todays = await ctx.service.listTransactions({ agentId: agent.id });
    expect(todays.reduce((sum, tx) => sum + tx.amountKobo, 0)).toBe(600_000);
  });

  it('resets the limit on the next business date (UTC)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T10:00:00.000Z'));
    const ctx = await makeService();
    const agent = await activeAgent(ctx, 500_000);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);

    await ctx.service.cashIn(agent.id, cashInInput(ctx, 'ci-day1-1', 500_000), agentActor(ctx.agentUser));
    await expect(
      ctx.service.cashIn(agent.id, cashInInput(ctx, 'ci-day1-2', 100_000), agentActor(ctx.agentUser))
    ).rejects.toBeInstanceOf(BadRequestException);

    // Next UTC business date: a fresh counter row, the full cap is available.
    vi.setSystemTime(new Date('2026-03-02T10:00:00.000Z'));
    await ctx.service.cashIn(agent.id, cashInInput(ctx, 'ci-day2-1', 500_000), agentActor(ctx.agentUser));
    await expect(
      ctx.service.cashIn(agent.id, cashInInput(ctx, 'ci-day2-2', 100_000), agentActor(ctx.agentUser))
    ).rejects.toBeInstanceOf(BadRequestException);

    const all = await ctx.service.listTransactions({ agentId: agent.id });
    expect(all.reduce((sum, tx) => sum + tx.amountKobo, 0)).toBe(1_000_000);
  });
});
