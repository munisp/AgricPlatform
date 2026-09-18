import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryAgentBankingAgentRepository,
  createInMemoryAgentDeviceRepository,
  createInMemoryAgentFloatTopUpRepository,
  createInMemoryAgentReversalRepository,
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
  agentRefundsPayableAccountCode,
  agentVoucherLiabilityAccountCode,
  farmerWalletAccountCode,
  type ActorRef
} from './agent-banking.service.js';
import { StubOtpDriver, stubOtpCode } from './otp.driver.js';

const ADMIN: ActorRef = { id: 'user-admin', roles: ['admin'] };
const ADMIN_TWO: ActorRef = { id: 'user-admin-two', roles: ['admin'] };
const DEVICE_TOKEN = 'device-token-0123456789abcdef';
const DEVICE_TOKEN_TWO = 'device-token-abcdef0123456789';

async function makeService(env: NodeJS.ProcessEnv = {}) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const users = new UsersService(createInMemoryUserRepository());
  const agents = createInMemoryAgentBankingAgentRepository();
  const topUps = createInMemoryAgentFloatTopUpRepository();
  const vouchers = createInMemoryAgentVoucherRepository();
  const transactions = createInMemoryAgentTransactionRepository();
  const reversals = createInMemoryAgentReversalRepository();
  const devices = createInMemoryAgentDeviceRepository();
  const service = new AgentBankingService(
    agents,
    topUps,
    vouchers,
    transactions,
    ledger,
    users,
    events,
    new StubOtpDriver(),
    new StubMojaloopAdapter(),
    env,
    reversals,
    devices
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
  return { service, ledger, users, events, agentUser, farmer, agents, topUps, vouchers, transactions, reversals, devices };
}

type Ctx = Awaited<ReturnType<typeof makeService>>;

function agentActor(user: User): ActorRef {
  return { id: user.id, roles: ['agent'] };
}

async function activeAgent(ctx: Ctx, limits: { dailyLimitKobo?: number } = {}) {
  const agent = await ctx.service.registerAgent(
    {
      userId: ctx.agentUser.id,
      organisation: 'Kano Farmers Cooperative',
      dailyLimitKobo: limits.dailyLimitKobo ?? 10_000_000
    },
    ADMIN.id
  );
  await ctx.service.setAgentStatus(agent.id, 'ACTIVE', ADMIN.id);
  return ctx.service.getAgent(agent.id);
}

async function fundPlatformCash(ctx: Ctx, amountKobo: number) {
  await ctx.ledger.ensureAccount({ code: 'platform:float_funding', type: 'equity' });
  await ctx.ledger.postEntry(
    {
      idempotencyKey: `fund-platform-${amountKobo}-${Math.random()}`,
      referenceType: 'test_funding',
      referenceId: 'test',
      description: 'test funding',
      postings: [
        { accountCode: PLATFORM_CASH_ACCOUNT, direction: 'debit', amountKobo },
        { accountCode: 'platform:float_funding', direction: 'credit', amountKobo }
      ]
    },
    ADMIN.id
  );
}

async function fundFloat(ctx: Ctx, agentId: string, amountKobo: number) {
  await fundPlatformCash(ctx, amountKobo);
  const request = await ctx.service.requestTopUp(agentId, { amountKobo, idempotencyKey: `tu-${Math.random()}` }, ADMIN);
  await ctx.service.decideTopUp(request.id, 'approve', ADMIN.id);
  return ctx.service.settleTopUp(request.id, ADMIN.id);
}

async function floatOf(ctx: Ctx, agentId: string): Promise<number> {
  return (await ctx.ledger.balance(agentFloatAccountCode(agentId))).balanceKobo;
}

async function liabilityOf(ctx: Ctx, accountCode: string): Promise<number> {
  const balance = await ctx.ledger.balance(accountCode);
  return balance.creditsKobo - balance.debitsKobo;
}

describe('AgentBankingService — W2-C2 V-33 paid-voucher liability + expiry refund', () => {
  it('issuance books the cash-received liability; redemption settles it exactly once', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundFloat(ctx, agent.id, 1_000_000);
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 50_000, idempotencyKey: 'v-issue-1' },
      agentActor(ctx.agentUser)
    );
    expect(voucher.issuanceLedgerEntryId).toBeTruthy();
    expect(await liabilityOf(ctx, agentVoucherLiabilityAccountCode(agent.id))).toBe(50_000);

    const { voucher: redeemed } = await ctx.service.redeemVoucher(voucher.id, undefined, agentActor(ctx.agentUser));
    expect(redeemed.status).toBe('REDEEMED');
    expect(redeemed.settleLedgerEntryId).toBeTruthy();
    // Liability settled: voucher_liability nets zero; float gained the cash at
    // issue and paid out e-money at redemption (net float = topup - payout...).
    expect(await liabilityOf(ctx, agentVoucherLiabilityAccountCode(agent.id))).toBe(0);
    const wallet = await ctx.ledger.balance(farmerWalletAccountCode(ctx.farmer.id));
    expect(wallet.balanceKobo).toBe(50_000);
    const settlement = await ctx.service.agentSettlement(agent.id);
    expect(settlement.vouchersOutstandingLiabilityKobo).toBe(0);
    expect(settlement.pendingRefunds).toEqual([]);
  });

  it('an expired paid voucher creates a refundable liability in the agent settlement', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundFloat(ctx, agent.id, 1_000_000);
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 70_000, idempotencyKey: 'v-issue-exp' },
      agentActor(ctx.agentUser)
    );
    const expired = await ctx.service.expireVoucher(voucher.id, ADMIN);
    expect(expired.status).toBe('EXPIRED');
    expect(expired.refundStatus).toBe('PAYABLE');
    // The obligation moved voucher_liability → refunds_payable.
    expect(await liabilityOf(ctx, agentVoucherLiabilityAccountCode(agent.id))).toBe(0);
    expect(await liabilityOf(ctx, agentRefundsPayableAccountCode(agent.id))).toBe(70_000);
    // Visible in the agent settlement queue.
    const settlement = await ctx.service.agentSettlement(agent.id);
    expect(settlement.refundsPayableKobo).toBe(70_000);
    expect(settlement.pendingRefunds).toEqual([
      { voucherId: voucher.id, farmerId: ctx.farmer.id, amountKobo: 70_000 }
    ]);
    // Confirming the cash hand-back settles it (PAYABLE→PAID), replay-safe.
    const paid = await ctx.service.confirmVoucherRefund(voucher.id, agentActor(ctx.agentUser));
    expect(paid.refundStatus).toBe('PAID');
    const replay = await ctx.service.confirmVoucherRefund(voucher.id, agentActor(ctx.agentUser));
    expect(replay.refundStatus).toBe('PAID');
    expect(await liabilityOf(ctx, agentRefundsPayableAccountCode(agent.id))).toBe(0);
    const after = await ctx.service.agentSettlement(agent.id);
    expect(after.pendingRefunds).toEqual([]);
    // A voucher never redeemed can never be redeemed after expiry (410 Gone).
    await expect(
      ctx.service.redeemVoucher(voucher.id, undefined, agentActor(ctx.agentUser))
    ).rejects.toMatchObject({ status: 410 });
  });

  it('redeeming a PAST-EXPIRY paid voucher books the refund and answers 410', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundFloat(ctx, agent.id, 1_000_000);
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      {
        farmerId: ctx.farmer.id,
        amountKobo: 30_000,
        idempotencyKey: 'v-issue-short',
        expiresAt: new Date(Date.now() + 40).toISOString()
      },
      agentActor(ctx.agentUser)
    );
    await new Promise((resolve) => setTimeout(resolve, 70));
    await expect(
      ctx.service.redeemVoucher(voucher.id, undefined, agentActor(ctx.agentUser))
    ).rejects.toMatchObject({ status: 410 });
    const stored = await ctx.service.getVoucher(voucher.id);
    expect(stored.status).toBe('EXPIRED');
    expect(stored.refundStatus).toBe('PAYABLE');
    expect(await liabilityOf(ctx, agentRefundsPayableAccountCode(agent.id))).toBe(30_000);
  });
});

describe('AgentBankingService — W2-C2 V-08 reversal instrument (maker-checker)', () => {
  async function postedCashIn(ctx: Ctx, agentId: string, amountKobo = 40_000, key = 'ci-1') {
    await fundFloat(ctx, agentId, 1_000_000);
    return ctx.service.cashIn(
      agentId,
      {
        farmerId: ctx.farmer.id,
        amountKobo,
        otp: stubOtpCode(ctx.farmer.id, key),
        idempotencyKey: key
      },
      agentActor(ctx.agentUser)
    );
  }

  it('approve posts the exact inverse entry, corrects the daily-limit counter, links the fraud case', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx, { dailyLimitKobo: 50_000 });
    const tx = await postedCashIn(ctx, agent.id, 40_000);
    const walletBefore = (await ctx.ledger.balance(farmerWalletAccountCode(ctx.farmer.id))).balanceKobo;
    expect(walletBefore).toBe(40_000);
    const floatBefore = await floatOf(ctx, agent.id);

    const initiated = await ctx.service.initiateReversal(
      agent.id,
      { transactionId: tx.id, reason: 'fake deposit', fraudCaseId: 'fraud-9', idempotencyKey: 'rev-1' },
      agentActor(ctx.agentUser)
    );
    expect(initiated.status).toBe('PENDING');

    // Maker-checker: the initiator cannot approve their own reversal.
    await expect(
      ctx.service.decideReversal(initiated.id, 'approve', agentActor(ctx.agentUser))
    ).rejects.toBeInstanceOf(ForbiddenException);
    // A different admin approves.
    const posted = await ctx.service.decideReversal(initiated.id, 'approve', ADMIN_TWO);
    expect(posted.status).toBe('POSTED');
    expect(posted.ledgerEntryId).toBeTruthy();
    expect(posted.reversalTransactionId).toBeTruthy();

    // Exact inverse: wallet returns to zero and the float regains the 40k
    // the fake deposit drew down.
    expect((await ctx.ledger.balance(farmerWalletAccountCode(ctx.farmer.id))).balanceKobo).toBe(0);
    expect(await floatOf(ctx, agent.id)).toBe(floatBefore + 40_000);
    // The reversal transaction row links the original + the fraud case.
    const reversalTx = await ctx.transactions.findById(posted.reversalTransactionId!);
    expect(reversalTx?.type).toBe('reversal');
    expect(reversalTx?.reversalOfTransactionId).toBe(tx.id);
    expect(reversalTx?.fraudCaseId).toBe('fraud-9');
    expect(reversalTx?.commissionKobo).toBe(-tx.commissionKobo);

    // Daily-limit counter corrected: the reversed 40k no longer counts, so a
    // fresh 45k cash-in fits under the 50k cap (would have been 85k > 50k).
    await ctx.service.cashIn(
      agent.id,
      {
        farmerId: ctx.farmer.id,
        amountKobo: 45_000,
        otp: stubOtpCode(ctx.farmer.id, 'ci-after'),
        idempotencyKey: 'ci-after'
      },
      agentActor(ctx.agentUser)
    );

    // Idempotent: re-approving replays without reposting; a second reversal conflicts.
    const again = await ctx.service.decideReversal(initiated.id, 'approve', ADMIN_TWO);
    expect(again.status).toBe('POSTED');
    expect(again.ledgerEntryId).toBe(posted.ledgerEntryId);
    await expect(
      ctx.service.initiateReversal(
        agent.id,
        { transactionId: tx.id, reason: 'again', idempotencyKey: 'rev-2' },
        ADMIN
      )
    ).rejects.toBeInstanceOf(ConflictException);
    // Initiation replays on its own key.
    const replay = await ctx.service.initiateReversal(
      agent.id,
      { transactionId: tx.id, reason: 'fake deposit', fraudCaseId: 'fraud-9', idempotencyKey: 'rev-1' },
      ADMIN
    );
    expect(replay.id).toBe(initiated.id);
  });

  it('rejects a reversal of voucher redemptions and non-admin decisions', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundFloat(ctx, agent.id, 1_000_000);
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 20_000, idempotencyKey: 'v-r' },
      agentActor(ctx.agentUser)
    );
    const { transaction } = await ctx.service.redeemVoucher(voucher.id, undefined, agentActor(ctx.agentUser));
    await expect(
      ctx.service.initiateReversal(
        agent.id,
        { transactionId: transaction.id, reason: 'x', idempotencyKey: 'rev-x' },
        ADMIN
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reject releases the live slot so a corrected reversal can be initiated', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    const tx = await postedCashIn(ctx, agent.id, 10_000, 'ci-r');
    const first = await ctx.service.initiateReversal(
      agent.id,
      { transactionId: tx.id, reason: 'wrong case', idempotencyKey: 'rev-r1' },
      ADMIN
    );
    const rejected = await ctx.service.decideReversal(first.id, 'reject', ADMIN_TWO);
    expect(rejected.status).toBe('REJECTED');
    const second = await ctx.service.initiateReversal(
      agent.id,
      { transactionId: tx.id, reason: 'corrected case', idempotencyKey: 'rev-r2' },
      ADMIN
    );
    expect(second.status).toBe('PENDING');
  });
});

describe('AgentBankingService — W2-C2 V-40 deregistration close-out', () => {
  it('sweeps the float to zero with balanced legs, settles commission, honours vouchers in grace', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundFloat(ctx, agent.id, 500_000);
    // A pre-issued voucher survives the close-out within the grace window.
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 25_000, idempotencyKey: 'v-dereg' },
      agentActor(ctx.agentUser)
    );
    const deregistered = await ctx.service.deregisterAgent(agent.id, { reason: 'retired' }, ADMIN.id);
    expect(deregistered.status).toBe('DEREGISTERED');
    expect(deregistered.deregisteredAt).toBeTruthy();
    expect(deregistered.voucherGraceUntil).toBeTruthy();

    // Float swept to zero (balanced legs DR platform:cash / CR float).
    expect(await floatOf(ctx, agent.id)).toBe(0);
    // Replay is idempotent — no second sweep.
    const replay = await ctx.service.deregisterAgent(agent.id, {}, ADMIN.id);
    expect(replay.status).toBe('DEREGISTERED');
    expect(await floatOf(ctx, agent.id)).toBe(0);

    // Cash endpoints and new issuance stay blocked for a deregistered agent.
    await expect(
      ctx.service.cashIn(
        agent.id,
        {
          farmerId: ctx.farmer.id,
          amountKobo: 1_000,
          otp: stubOtpCode(ctx.farmer.id, 'ci-dereg'),
          idempotencyKey: 'ci-dereg'
        },
        agentActor(ctx.agentUser)
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ctx.service.issueVoucher(
        agent.id,
        { farmerId: ctx.farmer.id, amountKobo: 1_000, idempotencyKey: 'v-dereg-2' },
        agentActor(ctx.agentUser)
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    // Grace window: the pre-issued voucher redeems.
    const { voucher: redeemed } = await ctx.service.redeemVoucher(voucher.id, undefined, ADMIN);
    expect(redeemed.status).toBe('REDEEMED');
  });

  it('vouchers are refused after the grace window closes (refund path instead)', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundFloat(ctx, agent.id, 500_000);
    const voucher = await ctx.service.issueVoucher(
      agent.id,
      { farmerId: ctx.farmer.id, amountKobo: 15_000, idempotencyKey: 'v-grace' },
      agentActor(ctx.agentUser)
    );
    await ctx.service.deregisterAgent(agent.id, { voucherGraceDays: 0 }, ADMIN.id);
    await expect(
      ctx.service.redeemVoucher(voucher.id, undefined, ADMIN)
    ).rejects.toBeInstanceOf(BadRequestException);
    // The refund path still works (V-33): expire → refundable liability.
    const expired = await ctx.service.expireVoucher(voucher.id, ADMIN);
    expect(expired.refundStatus).toBe('PAYABLE');
  });

  it('setAgentStatus cannot jump into the close-out states', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await expect(ctx.service.setAgentStatus(agent.id, 'DEREGISTERED', ADMIN.id)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });
});

describe('AgentBankingService — W2-C2 V-41 device binding + remote freeze', () => {
  it('revoked device tokens are rejected on cash endpoints; re-enrolment is audited', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await fundFloat(ctx, agent.id, 1_000_000);
    const publish = vi.spyOn(ctx.events, 'publish');

    // Legacy mode: no bindings → cash works without a token.
    await ctx.service.cashIn(
      agent.id,
      {
        farmerId: ctx.farmer.id,
        amountKobo: 5_000,
        otp: stubOtpCode(ctx.farmer.id, 'ci-d0'),
        idempotencyKey: 'ci-d0'
      },
      agentActor(ctx.agentUser)
    );

    const device = await ctx.service.bindDevice(
      agent.id,
      { deviceToken: DEVICE_TOKEN, label: 'POS-1' },
      agentActor(ctx.agentUser)
    );
    expect(device.status).toBe('ACTIVE');
    expect(device.deviceTokenHash).not.toContain(DEVICE_TOKEN); // hash-at-rest
    // Re-bind replays.
    const rebound = await ctx.service.bindDevice(agent.id, { deviceToken: DEVICE_TOKEN }, agentActor(ctx.agentUser));
    expect(rebound.id).toBe(device.id);

    // Now bound: the token is mandatory and must be ACTIVE.
    await expect(
      ctx.service.cashIn(
        agent.id,
        {
          farmerId: ctx.farmer.id,
          amountKobo: 5_000,
          otp: stubOtpCode(ctx.farmer.id, 'ci-d1'),
          idempotencyKey: 'ci-d1'
        },
        agentActor(ctx.agentUser)
      )
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      ctx.service.cashIn(
        agent.id,
        {
          farmerId: ctx.farmer.id,
          amountKobo: 5_000,
          otp: stubOtpCode(ctx.farmer.id, 'ci-d2'),
          idempotencyKey: 'ci-d2',
          deviceToken: 'unknown-device-token-999'
        },
        agentActor(ctx.agentUser)
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
    await ctx.service.cashIn(
      agent.id,
      {
        farmerId: ctx.farmer.id,
        amountKobo: 5_000,
        otp: stubOtpCode(ctx.farmer.id, 'ci-d3'),
        idempotencyKey: 'ci-d3',
        deviceToken: DEVICE_TOKEN
      },
      agentActor(ctx.agentUser)
    );

    // Remote freeze: revoked token rejected on cash endpoints.
    const revoked = await ctx.service.revokeDevice(agent.id, device.id, ADMIN, 'device stolen');
    expect(revoked.status).toBe('REVOKED');
    await expect(
      ctx.service.cashOut(
        agent.id,
        {
          farmerId: ctx.farmer.id,
          amountKobo: 5_000,
          otp: stubOtpCode(ctx.farmer.id, 'co-d1'),
          idempotencyKey: 'co-d1',
          deviceToken: DEVICE_TOKEN
        },
        agentActor(ctx.agentUser)
      )
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // A revoked device cannot be re-bound (fail closed).
    await expect(
      ctx.service.bindDevice(agent.id, { deviceToken: DEVICE_TOKEN }, agentActor(ctx.agentUser))
    ).rejects.toBeInstanceOf(ConflictException);

    // New-device re-enrolment is audited with the re-enrolment event.
    await ctx.service.bindDevice(agent.id, { deviceToken: DEVICE_TOKEN_TWO }, agentActor(ctx.agentUser));
    const topics = publish.mock.calls.map((call) => call[0]);
    expect(topics).toContain('agentbank.agent.device_bound');
    expect(topics).toContain('agentbank.agent.device_revoked');
    expect(topics).toContain('agentbank.agent.device_reenrolled');
    await ctx.service.cashIn(
      agent.id,
      {
        farmerId: ctx.farmer.id,
        amountKobo: 5_000,
        otp: stubOtpCode(ctx.farmer.id, 'ci-d4'),
        idempotencyKey: 'ci-d4',
        deviceToken: DEVICE_TOKEN_TWO
      },
      agentActor(ctx.agentUser)
    );
  });

  it('rejects weak device tokens and foreign-device revocation', async () => {
    const ctx = await makeService();
    const agent = await activeAgent(ctx);
    await expect(
      ctx.service.bindDevice(agent.id, { deviceToken: 'short' }, agentActor(ctx.agentUser))
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
