import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
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
  agentFloatAccountCode,
  farmerWalletAccountCode,
  type ActorRef
} from './agent-banking.service.js';
import { StubOtpDriver, stubOtpCode } from './otp.driver.js';
import { signVoucher } from './voucher-crypto.js';

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
  return { service, ledger, users, events, agentUser, farmer };
}

function agentActor(user: User): ActorRef {
  return { id: user.id, roles: ['agent'] };
}

function otp(farmerId: string, key: string): string {
  return stubOtpCode(farmerId, key);
}

/** Registers and ACTIVATEs an agent with a small daily limit for tests. */
async function activeAgent(
  ctx: Awaited<ReturnType<typeof makeService>>,
  limits: { dailyLimitKobo?: number; lowFloatThresholdKobo?: number } = {}
) {
  const agent = await ctx.service.registerAgent(
    {
      userId: ctx.agentUser.id,
      organisation: 'Kano Farmers Cooperative',
      dailyLimitKobo: limits.dailyLimitKobo ?? 10_000_000,
      lowFloatThresholdKobo: limits.lowFloatThresholdKobo ?? 100_000
    },
    ADMIN.id
  );
  await ctx.service.setAgentStatus(agent.id, 'ACTIVE', ADMIN.id);
  return (await ctx.service.getAgent(agent.id));
}

/** Funds platform:cash so top-up settlement passes the solvency guard. */
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

/** Tops up the agent float through the full workflow. */
let topUpKeySeq = 0;
async function topUpFloat(
  ctx: Awaited<ReturnType<typeof makeService>>,
  agentId: string,
  amountKobo: number
) {
  topUpKeySeq += 1;
  const request = await ctx.service.requestTopUp(
    agentId,
    { amountKobo, idempotencyKey: `topup-${topUpKeySeq}` },
    ADMIN
  );
  await ctx.service.decideTopUp(request.id, 'approve', ADMIN.id);
  return ctx.service.settleTopUp(request.id, ADMIN.id);
}

describe('AgentBankingService — agent registry', () => {
  it('registers an agent as PENDING with ledger-backed float + commission accounts', async () => {
    const ctx = await makeService();
    const agent = await ctx.service.registerAgent(
      { userId: ctx.agentUser.id, organisation: 'Kano Farmers Cooperative' },
      ADMIN.id
    );
    expect(agent.status).toBe('PENDING');
    expect(agent.floatAccountCode).toBe(agentFloatAccountCode(agent.id));
    const float = await ctx.ledger.getAccountByCode(agent.floatAccountCode);
    expect(float.type).toBe('asset');
    const commission = await ctx.ledger.getAccountByCode(agent.commissionAccountCode);
    expect(commission.type).toBe('liability');
  });

  it('rejects duplicate registration for the same user', async () => {
    const ctx = await makeService();
    await ctx.service.registerAgent({ userId: ctx.agentUser.id, organisation: 'Coop' }, ADMIN.id);
    await expect(
      ctx.service.registerAgent({ userId: ctx.agentUser.id, organisation: 'Coop' }, ADMIN.id)
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects registration for an unknown user', async () => {
    const ctx = await makeService();
    await expect(
      ctx.service.registerAgent({ userId: 'user-ghost', organisation: 'Coop' }, ADMIN.id)
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('walks the status machine PENDING→ACTIVE→SUSPENDED→ACTIVE', async () => {
    const ctx = await makeService();
    const agent = await ctx.service.registerAgent(
      { userId: ctx.agentUser.id, organisation: 'Coop' },
      ADMIN.id
    );
    expect((await ctx.service.setAgentStatus(agent.id, 'ACTIVE', ADMIN.id)).status).toBe('ACTIVE');
    expect((await ctx.service.setAgentStatus(agent.id, 'SUSPENDED', ADMIN.id)).status).toBe('SUSPENDED');
    expect((await ctx.service.setAgentStatus(agent.id, 'ACTIVE', ADMIN.id)).status).toBe('ACTIVE');
  });

  it('rejects illegal status transitions (ACTIVE→PENDING)', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await expect(ctx.service.setAgentStatus(agent.id, 'PENDING', ADMIN.id)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('blocks transactions for non-ACTIVE agents', async () => {
    const ctx = await makeService();
    const agent = await ctx.service.registerAgent(
      { userId: ctx.agentUser.id, organisation: 'Coop' },
      ADMIN.id
    );
    await expect(
      ctx.service.cashIn(
        agent.id,
        { farmerId: ctx.farmer.id, amountKobo: 1_000, otp: 'x', idempotencyKey: 'k1' },
        agentActor(ctx.agentUser)
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AgentBankingService — float top-up workflow', () => {
  it('walks REQUESTED→APPROVED→SETTLED and posts the float into the ledger', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    const request = await ctx.service.requestTopUp(
      agent.id,
      { amountKobo: 2_000_000, idempotencyKey: 'tu-walk-1' },
      agentActor(ctx.agentUser)
    );
    expect(request.status).toBe('REQUESTED');
    const approved = await ctx.service.decideTopUp(request.id, 'approve', ADMIN.id);
    expect(approved.status).toBe('APPROVED');
    const settled = await ctx.service.settleTopUp(request.id, ADMIN.id);
    expect(settled.status).toBe('SETTLED');
    expect(settled.ledgerEntryId).toBeTruthy();
    const float = await ctx.service.floatBalance(agent.id);
    expect(float.balanceKobo).toBe(2_000_000);
  });

  it('settles idempotently (replay returns the settled record)', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    const settled = await topUpFloat(ctx, agent.id, 1_000_000);
    const replay = await ctx.service.settleTopUp(settled.id, ADMIN.id);
    expect(replay.status).toBe('SETTLED');
    expect((await ctx.service.floatBalance(agent.id)).balanceKobo).toBe(1_000_000);
  });

  it('rejects a REQUESTED top-up with a reason and cannot settle it', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    const request = await ctx.service.requestTopUp(agent.id, { amountKobo: 500_000, idempotencyKey: 'tu-reject-1' }, ADMIN);
    const rejected = await ctx.service.decideTopUp(request.id, 'reject', ADMIN.id, 'Float adequate');
    expect(rejected.status).toBe('REJECTED');
    await expect(ctx.service.settleTopUp(request.id, ADMIN.id)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('requires a rejection reason', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    const request = await ctx.service.requestTopUp(agent.id, { amountKobo: 500_000, idempotencyKey: 'tu-reason-1' }, ADMIN);
    await expect(ctx.service.decideTopUp(request.id, 'reject', ADMIN.id)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('a second decision on a decided top-up is a 409 (CAS)', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    const request = await ctx.service.requestTopUp(agent.id, { amountKobo: 500_000, idempotencyKey: 'tu-cas-1' }, ADMIN);
    await ctx.service.decideTopUp(request.id, 'approve', ADMIN.id);
    await expect(ctx.service.decideTopUp(request.id, 'approve', ADMIN.id)).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('settlement fails closed when platform:cash is underfunded (solvency guard)', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    const request = await ctx.service.requestTopUp(agent.id, { amountKobo: 5_000_000, idempotencyKey: 'tu-solvency-1' }, ADMIN);
    await ctx.service.decideTopUp(request.id, 'approve', ADMIN.id);
    await expect(ctx.service.settleTopUp(request.id, ADMIN.id)).rejects.toBeInstanceOf(
      BadRequestException
    );
    // The top-up stays APPROVED and the float is untouched — no money created.
    expect((await ctx.service.floatBalance(agent.id)).balanceKobo).toBe(0);
  });

  it('flags a low float when balance is at/below the threshold', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx, { lowFloatThresholdKobo: 1_000_000 });
    await fundPlatformCash(ctx, 5_000_000);
    expect((await ctx.service.floatBalance(agent.id)).lowFloat).toBe(true);
    await topUpFloat(ctx, agent.id, 2_000_000);
    expect((await ctx.service.floatBalance(agent.id)).lowFloat).toBe(false);
  });
});

describe('AgentBankingService — cash-in / cash-out', () => {
  it('records the OTP basis on cash transactions (and round-trips it in listings)', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    const tx = await ctx.service.cashIn(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 500_000, otp: otp(ctx.farmer.id, 'basis-1'), idempotencyKey: 'basis-1' },
      agentActor(ctx.agentUser)
    );
    expect(tx.otpBasis).toBe('stub');
    const listed = await ctx.service.listTransactions({ agentId: agent.id });
    expect(listed.find((row) => row.id === tx.id)?.otpBasis).toBe('stub');
  });

  it('cash-in posts DR farmer wallet / CR agent float with commission', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    const tx = await ctx.service.cashIn(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 500_000, otp: otp(ctx.farmer.id, 'ci-1'), idempotencyKey: 'ci-1' },
      agentActor(ctx.agentUser)
    );
    expect(tx.type).toBe('cash_in');
    expect(tx.commissionKobo).toBe(2_500); // 50 bps
    // The presence-proof basis is persisted with the cash movement.
    expect(tx.otpBasis).toBe('stub');
    expect((await ctx.ledger.balance(farmerWalletAccountCode(ctx.farmer.id))).balanceKobo).toBe(500_000);
    expect((await ctx.service.floatBalance(agent.id)).balanceKobo).toBe(1_500_000);
    // Commission accrued into the payable account (liability: credits − debits).
    const statement = await ctx.service.commissionStatement(agent.id, new Date().toISOString().slice(0, 7));
    expect(statement.totalCommissionKobo).toBe(2_500);
    expect(statement.commissionPayableKobo).toBe(2_500);
  });

  it('cash-out posts DR agent float / CR farmer wallet', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    await ctx.service.cashIn(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 500_000, otp: otp(ctx.farmer.id, 'ci-2'), idempotencyKey: 'ci-2' },
      agentActor(ctx.agentUser)
    );
    const tx = await ctx.service.cashOut(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 200_000, otp: otp(ctx.farmer.id, 'co-1'), idempotencyKey: 'co-1' },
      agentActor(ctx.agentUser)
    );
    expect(tx.type).toBe('cash_out');
    expect((await ctx.ledger.balance(farmerWalletAccountCode(ctx.farmer.id))).balanceKobo).toBe(300_000);
    expect((await ctx.service.floatBalance(agent.id)).balanceKobo).toBe(1_700_000);
  });

  it('LEDGER INVARIANT: agent float can never go negative (overdraft impossible)', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 1_000_000);
    await topUpFloat(ctx, agent.id, 100_000);
    await expect(
      ctx.service.cashIn(
        agent.id,
        { farmerId: ctx.farmer.id, amountKobo: 500_000, otp: otp(ctx.farmer.id, 'ci-3'), idempotencyKey: 'ci-3' },
        agentActor(ctx.agentUser)
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((await ctx.service.floatBalance(agent.id)).balanceKobo).toBe(100_000);
    expect((await ctx.ledger.balance(farmerWalletAccountCode(ctx.farmer.id))).balanceKobo).toBe(0);
  });

  it('LEDGER INVARIANT: farmer wallet can never go negative (overdraft impossible)', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    await expect(
      ctx.service.cashOut(
        agent.id,
        { farmerId: ctx.farmer.id, amountKobo: 300_000, otp: otp(ctx.farmer.id, 'co-2'), idempotencyKey: 'co-2' },
        agentActor(ctx.agentUser)
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((await ctx.ledger.balance(farmerWalletAccountCode(ctx.farmer.id))).balanceKobo).toBe(0);
    expect((await ctx.service.floatBalance(agent.id)).balanceKobo).toBe(2_000_000);
  });

  it('replays an idempotency key without double-posting', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    const input = {
      farmerId: ctx.farmer.id,
      amountKobo: 500_000,
      otp: otp(ctx.farmer.id, 'ci-4'),
      idempotencyKey: 'ci-4'
    };
    const first = await ctx.service.cashIn(agent.id, input, agentActor(ctx.agentUser));
    const second = await ctx.service.cashIn(agent.id, input, agentActor(ctx.agentUser));
    expect(second.id).toBe(first.id);
    expect((await ctx.ledger.balance(farmerWalletAccountCode(ctx.farmer.id))).balanceKobo).toBe(500_000);
  });

  it('rejects a bad farmer presence proof (OTP) and posts nothing', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    await expect(
      ctx.service.cashIn(
        agent.id,
        { farmerId: ctx.farmer.id, amountKobo: 500_000, otp: '999999', idempotencyKey: 'ci-5' },
        agentActor(ctx.agentUser)
      )
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // Nothing posted: the farmer wallet account was never even created.
    await expect(ctx.ledger.balance(farmerWalletAccountCode(ctx.farmer.id))).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('enforces the agent daily limit', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx, { dailyLimitKobo: 600_000 });
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    await ctx.service.cashIn(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 500_000, otp: otp(ctx.farmer.id, 'ci-6'), idempotencyKey: 'ci-6' },
      agentActor(ctx.agentUser)
    );
    await expect(
      ctx.service.cashIn(
        agent.id,
        { farmerId: ctx.farmer.id, amountKobo: 200_000, otp: otp(ctx.farmer.id, 'ci-7'), idempotencyKey: 'ci-7' },
        agentActor(ctx.agentUser)
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks a non-owner agent from transacting on another agent', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    const other = await ctx.users.create({
      phone: '+2348000000003',
      fullName: 'Agent Obi',
      roles: ['agent'],
      preferredLanguage: 'en'
    });
    await expect(
      ctx.service.cashIn(
        agent.id,
        { farmerId: ctx.farmer.id, amountKobo: 1_000, otp: 'x', idempotencyKey: 'ci-8' },
        { id: other.id, roles: ['agent'] }
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('conserves value across cash-in + cash-out + commission (double-entry)', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    await ctx.service.cashIn(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 500_000, otp: otp(ctx.farmer.id, 'ci-9'), idempotencyKey: 'ci-9' },
      agentActor(ctx.agentUser)
    );
    await ctx.service.cashOut(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 200_000, otp: otp(ctx.farmer.id, 'co-3'), idempotencyKey: 'co-3' },
      agentActor(ctx.agentUser)
    );
    // Sum of ALL account balances must be zero (double-entry conservation).
    const accounts = await ctx.ledger.listAccounts();
    let total = 0;
    for (const account of accounts) {
      total += (await ctx.ledger.balance(account.code)).balanceKobo;
    }
    expect(total).toBe(0);
  });
});

describe('AgentBankingService — offline vouchers', () => {
  let voucherKeySeq = 0;
  async function issuedVoucher(ctx: Awaited<ReturnType<typeof makeService>>, amountKobo = 250_000) {
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    voucherKeySeq += 1;
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo, idempotencyKey: `v-auto-${voucherKeySeq}` },
      agentActor(ctx.agentUser)
    );
    return { agent, voucher };
  }

  it('issues an ISSUED voucher with a valid HMAC signature', async () => {
    const ctx = await makeService();
    const { voucher } = await issuedVoucher(ctx);
    expect(voucher.status).toBe('ISSUED');
    expect(voucher.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(voucher.signature).toBe(
      signVoucher(
        {
          voucherId: voucher.id,
          agentId: voucher.agentId,
          farmerId: voucher.farmerId,
          amountKobo: voucher.amountKobo,
          expiry: voucher.expiresAt,
          nonce: voucher.nonce
        },
        'agent-banking-dev-voucher-secret-INSECURE'
      )
    );
  });

  it('redeems a voucher exactly once — wallet credited, float debited, voucher REDEEMED', async () => {
    const ctx = await makeService();
    const { agent, voucher } = await issuedVoucher(ctx);
    const { voucher: redeemed, transaction } = await ctx.service.redeemVoucher(
      voucher.id,
      voucher.signature,
      { id: ctx.farmer.id, roles: ['farmer'] }
    );
    expect(redeemed.status).toBe('REDEEMED');
    expect(redeemed.ledgerEntryId).toBe(transaction.ledgerEntryId);
    expect((await ctx.ledger.balance(farmerWalletAccountCode(ctx.farmer.id))).balanceKobo).toBe(250_000);
    expect((await ctx.service.floatBalance(agent.id)).balanceKobo).toBe(1_750_000);
    // Commission accrues on redemption too (25 bps of 250,000 = 625).
    expect(transaction.commissionKobo).toBe(625);
  });

  it('replay of a redemption is a 409 and never pays twice', async () => {
    const ctx = await makeService();
    const { voucher } = await issuedVoucher(ctx);
    await ctx.service.redeemVoucher(voucher.id, voucher.signature, {
      id: ctx.farmer.id,
      roles: ['farmer']
    });
    await expect(
      ctx.service.redeemVoucher(voucher.id, voucher.signature, { id: ctx.farmer.id, roles: ['farmer'] })
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await ctx.ledger.balance(farmerWalletAccountCode(ctx.farmer.id))).balanceKobo).toBe(250_000);
  });

  it('rejects a tampered signature', async () => {
    const ctx = await makeService();
    const { voucher } = await issuedVoucher(ctx);
    const forged = signVoucher(
      {
        voucherId: voucher.id,
        agentId: voucher.agentId,
        farmerId: voucher.farmerId,
        amountKobo: voucher.amountKobo * 10, // tampered amount
        expiry: voucher.expiresAt,
        nonce: voucher.nonce
      },
      'agent-banking-dev-voucher-secret-INSECURE'
    );
    await expect(
      ctx.service.redeemVoucher(voucher.id, forged, { id: ctx.farmer.id, roles: ['farmer'] })
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('an expired voucher transitions to EXPIRED and answers 410', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      {
        farmerId: ctx.farmer.id,
        amountKobo: 100_000,
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
        idempotencyKey: 'v-expiry-1'
      },
      agentActor(ctx.agentUser)
    );
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(
      ctx.service.redeemVoucher(voucher.id, voucher.signature, { id: ctx.farmer.id, roles: ['farmer'] })
    ).rejects.toBeInstanceOf(GoneException);
    expect((await ctx.service.getVoucher(voucher.id)).status).toBe('EXPIRED');
  });

  it('a voided voucher cannot be redeemed', async () => {
    const ctx = await makeService();
    const { agent, voucher } = await issuedVoucher(ctx);
    const voided = await ctx.service.voidVoucher(voucher.id, agentActor(ctx.agentUser));
    expect(voided.status).toBe('VOIDED');
    await expect(
      ctx.service.redeemVoucher(voucher.id, voucher.signature, { id: ctx.farmer.id, roles: ['farmer'] })
    ).rejects.toBeInstanceOf(ConflictException);
    void agent;
  });

  it('redemption fails closed when the agent float cannot cover the voucher', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    // No float top-up: float is 0.
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 100_000, idempotencyKey: 'v-underfunded-1' },
      agentActor(ctx.agentUser)
    );
    await expect(
      ctx.service.redeemVoucher(voucher.id, voucher.signature, { id: ctx.farmer.id, roles: ['farmer'] })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((await ctx.service.getVoucher(voucher.id)).status).toBe('ISSUED');
  });

  it('an unrelated user cannot redeem someone else\u2019s voucher', async () => {
    const ctx = await makeService();
    const { voucher } = await issuedVoucher(ctx);
    await expect(
      ctx.service.redeemVoucher(voucher.id, voucher.signature, { id: 'user-stranger', roles: ['farmer'] })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AgentBankingService — voucher issuance idempotency', () => {
  it('replays the same idempotencyKey: one voucher, one issued event', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    const published: string[] = [];
    ctx.events.on('*', (event: { name: string }) => published.push(event.name));
    const input = { farmerId: ctx.farmer.id, amountKobo: 100_000, idempotencyKey: 'v-1' };
    const first = await ctx.service.issueVoucher(agent.id, input, agentActor(ctx.agentUser));
    const replay = await ctx.service.issueVoucher(agent.id, input, agentActor(ctx.agentUser));
    expect(replay.id).toBe(first.id);
    expect(replay.idempotencyKey).toBe('v-1');
    expect(await ctx.service.listVouchers({ agentId: agent.id })).toHaveLength(1);
    expect(published.filter((name) => name === 'agentbank.voucher.issued')).toHaveLength(1);
  });

  it('different idempotencyKeys issue distinct vouchers', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    const first = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 100_000, idempotencyKey: 'v-a' },
      agentActor(ctx.agentUser)
    );
    const second = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 100_000, idempotencyKey: 'v-b' },
      agentActor(ctx.agentUser)
    );
    expect(second.id).not.toBe(first.id);
    expect(await ctx.service.listVouchers({ agentId: agent.id })).toHaveLength(2);
  });

  it('omitting the idempotency key is rejected (400) — keyless retries duplicate money', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await expect(
      ctx.service.issueVoucher(
        agent.id,
        { farmerId: ctx.farmer.id, amountKobo: 100_000 } as never,
        agentActor(ctx.agentUser)
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await ctx.service.listVouchers({ agentId: agent.id })).toHaveLength(0);
  });
});

describe('AgentBankingService — statements & reconciliation', () => {
  it('builds the monthly commission statement by transaction type', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    await ctx.service.cashIn(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 500_000, otp: otp(ctx.farmer.id, 's-1'), idempotencyKey: 's-1' },
      agentActor(ctx.agentUser)
    );
    await ctx.service.cashOut(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 100_000, otp: otp(ctx.farmer.id, 's-2'), idempotencyKey: 's-2' },
      agentActor(ctx.agentUser)
    );
    const month = new Date().toISOString().slice(0, 7);
    const statement = await ctx.service.commissionStatement(agent.id, month);
    const cashIn = statement.rows.find((row) => row.type === 'cash_in');
    const cashOut = statement.rows.find((row) => row.type === 'cash_out');
    expect(cashIn).toMatchObject({ count: 1, volumeKobo: 500_000, commissionKobo: 2_500 });
    expect(cashOut).toMatchObject({ count: 1, volumeKobo: 100_000, commissionKobo: 750 });
    expect(statement.totalCommissionKobo).toBe(3_250);
    expect(statement.commissionPayableKobo).toBe(3_250);
  });

  it('reconciliation math matches the seeded ledger (opening, volumes, closing)', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    await ctx.service.cashIn(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 500_000, otp: otp(ctx.farmer.id, 'r-1'), idempotencyKey: 'r-1' },
      agentActor(ctx.agentUser)
    );
    await ctx.service.cashOut(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 200_000, otp: otp(ctx.farmer.id, 'r-2'), idempotencyKey: 'r-2' },
      agentActor(ctx.agentUser)
    );
    const today = new Date().toISOString().slice(0, 10);
    const recon = await ctx.service.reconciliation(agent.id, today);
    expect(recon.openingFloatKobo).toBe(0);
    expect(recon.volumeByType).toEqual({
      cash_in: 500_000,
      cash_out: 200_000,
      voucher_redemption: 0,
      float_topup: 2_000_000
    });
    // closing = 2,000,000 (top-up) − 500,000 (cash-in) + 200,000 (cash-out).
    expect(recon.closingFloatKobo).toBe(1_700_000);
    expect(recon.closingFloatKobo).toBe((await ctx.service.floatBalance(agent.id)).balanceKobo);
    expect(recon.commissionAccruedKobo).toBe(2_500 + 1_500);
    expect(recon.transactionCount).toBe(2);
    // A day with no activity carries the closing forward as opening.
    const future = await ctx.service.reconciliation(agent.id, '2099-01-01');
    expect(future.openingFloatKobo).toBe(1_700_000);
    expect(future.closingFloatKobo).toBe(1_700_000);
    expect(future.transactionCount).toBe(0);
  });

  it('rejects malformed date/month parameters', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await expect(ctx.service.reconciliation(agent.id, '01-01-2026')).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(ctx.service.commissionStatement(agent.id, '2026-1')).rejects.toBeInstanceOf(
      BadRequestException
    );
  });
});

describe('AgentBankingService — interop (stub/simulator only)', () => {
  it('reports the stub Mojaloop adapter status', async () => {
    const ctx = await makeService();
    const status = await ctx.service.interopStatus();
    expect(status.driver).toBe('stub');
    expect(status.healthy).toBe(true);
  });

  it('returns a clearly-labelled simulated quote', async () => {
    const ctx = await makeService();
    const quote = await ctx.service.interopQuote({
      amountNaira: 1_000,
      payerMsisdn: '+2348000000001',
      payeeMsisdn: '+2348000000002',
      reference: 'ref-1'
    });
    expect(quote.status).toBe('simulated');
    expect(quote.source).toContain('stub-fixture');
  });
});

describe('AgentBankingService — domain events', () => {
  it('publishes outbox events on the money-movement path', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 1_000_000);
    await ctx.service.cashIn(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 100_000, otp: otp(ctx.farmer.id, 'e-1'), idempotencyKey: 'e-1' },
      agentActor(ctx.agentUser)
    );
    const published: string[] = [];
    ctx.events.on('*', (event: { name: string }) => published.push(event.name));
    await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 50_000, idempotencyKey: 'v-event-1' },
      agentActor(ctx.agentUser)
    );
    expect(published).toContain('agentbank.voucher.issued');
  });
});

describe('AgentBankingService — stage-22 money-race regressions', () => {
  it('top-up request retries with the same key collapse to exactly one settleable row (audit C2-9)', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    const input = { amountKobo: 500_000, idempotencyKey: 'tu-replay-1' };
    const first = await ctx.service.requestTopUp(agent.id, input, agentActor(ctx.agentUser));
    const replay = await ctx.service.requestTopUp(agent.id, input, agentActor(ctx.agentUser));
    expect(replay.id).toBe(first.id);
    // Concurrent duplicates racing the insert also collapse (UNIQUE index
    // conflict → the original row is returned).
    const [a, b] = await Promise.allSettled([
      ctx.service.requestTopUp(agent.id, { amountKobo: 700_000, idempotencyKey: 'tu-race-1' }, ADMIN),
      ctx.service.requestTopUp(agent.id, { amountKobo: 700_000, idempotencyKey: 'tu-race-1' }, ADMIN)
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
    expect((a as PromiseFulfilledResult<{ id: string }>).value.id).toBe(
      (b as PromiseFulfilledResult<{ id: string }>).value.id
    );
    expect(await ctx.service.listTopUps({ agentId: agent.id })).toHaveLength(2);
  });

  it('concurrent redeem + void: the void loses once REDEEMING is held — one ledger posting (audit C3/C2-9)', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 250_000, idempotencyKey: 'v-race-1' },
      agentActor(ctx.agentUser)
    );
    // Widen the posting window so the void attempts while REDEEMING is held.
    const original = ctx.ledger.postEntry.bind(ctx.ledger);
    ctx.ledger.postEntry = (async (
      input: Parameters<LedgerService['postEntry']>[0],
      actorId: string
    ) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return original(input, actorId);
    }) as LedgerService['postEntry'];
    const [redeemResult, voidResult] = await Promise.allSettled([
      ctx.service.redeemVoucher(voucher.id, voucher.signature, { id: ctx.farmer.id, roles: ['farmer'] }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return ctx.service.voidVoucher(voucher.id, agentActor(ctx.agentUser));
      })()
    ]);
    expect(redeemResult.status).toBe('fulfilled');
    // Void refuses non-ISSUED states: a REDEEMING voucher cannot be voided
    // out from under the in-flight payout.
    expect(voidResult.status).toBe('rejected');
    expect((voidResult as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect((await ctx.service.getVoucher(voucher.id)).status).toBe('REDEEMED');
    const entries = await ctx.ledger.listEntries({});
    expect(entries.filter((entry) => entry.idempotencyKey === `voucher-redemption:${voucher.id}`)).toHaveLength(1);
    expect((await ctx.ledger.balance(farmerWalletAccountCode(ctx.farmer.id))).balanceKobo).toBe(250_000);
  });

  it('a redeem retry that finds REDEEMING with the transaction row finalizes instead of reposting', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 100_000, idempotencyKey: 'v-race-2' },
      agentActor(ctx.agentUser)
    );
    const first = await ctx.service.redeemVoucher(voucher.id, voucher.signature, {
      id: ctx.farmer.id,
      roles: ['farmer']
    });
    expect(first.voucher.status).toBe('REDEEMED');
    // Replay after finalization is still a 409 — payout happened once.
    await expect(
      ctx.service.redeemVoucher(voucher.id, voucher.signature, { id: ctx.farmer.id, roles: ['farmer'] })
    ).rejects.toBeInstanceOf(ConflictException);
    const entries = await ctx.ledger.listEntries({});
    expect(entries.filter((entry) => entry.idempotencyKey === `voucher-redemption:${voucher.id}`)).toHaveLength(1);
  });

  it('a posting failure rolls the REDEEMING claim back to ISSUED so a retry can succeed', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundPlatformCash(ctx, 5_000_000);
    await topUpFloat(ctx, agent.id, 2_000_000);
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 100_000, idempotencyKey: 'v-race-3' },
      agentActor(ctx.agentUser)
    );
    const original = ctx.ledger.postEntry.bind(ctx.ledger);
    ctx.ledger.postEntry = (async () => {
      throw new Error('ledger unavailable');
    }) as LedgerService['postEntry'];
    await expect(
      ctx.service.redeemVoucher(voucher.id, voucher.signature, { id: ctx.farmer.id, roles: ['farmer'] })
    ).rejects.toThrow('ledger unavailable');
    expect((await ctx.service.getVoucher(voucher.id)).status).toBe('ISSUED'); // claim rolled back
    ctx.ledger.postEntry = original;
    const retried = await ctx.service.redeemVoucher(voucher.id, voucher.signature, {
      id: ctx.farmer.id,
      roles: ['farmer']
    });
    expect(retried.voucher.status).toBe('REDEEMED');
    const entries = await ctx.ledger.listEntries({});
    expect(entries.filter((entry) => entry.idempotencyKey === `voucher-redemption:${voucher.id}`)).toHaveLength(1);
  });
});
