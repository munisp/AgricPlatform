import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryAgentBankingAgentRepository,
  createInMemoryAgentVoucherRepository,
  type AgentRecord
} from '../../database/repositories/agent-banking.repository.js';
import {
  createInMemoryMerchantPaymentRepository,
  createInMemoryMerchantQrCodeRepository
} from '../../database/repositories/dealer-qr.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { UsersService } from '../users/users.service.js';
import {
  StubMojaloopAdapter,
  type LiveMojaloopAdapter,
  type MojaloopAdapter,
  type MojaloopAdapterStatus,
  type MojaloopPartyLookup,
  type MojaloopQuote,
  type MojaloopQuoteInput,
  type MojaloopTransfer,
  type MojaloopTransferCallback,
  type MojaloopTransferInput
} from '../integrations/drivers/mojaloop.driver.js';
import {
  DEALER_QR_PAY_FLAG,
  DealerQrService,
  PLATFORM_MOJALOOP_SETTLEMENT_ACCOUNT,
  dealerReceivableAccountCode,
  splitCoPayTender,
  type ActorRef
} from './dealer-qr.service.js';
import { agentFloatAccountCode } from './agent-banking.service.js';
import { DEV_VOUCHER_SECRET, signVoucher } from './voucher-crypto.js';
import { verifyQrSignature } from './qr-crypto.js';

/**
 * Dealer QR Pay service specs (Stage 27, Innovation 16): quote→transfer
 * state machine, co-pay split math (voucher + wallet = amount, integer
 * kobo), fail-closed adapter gating, replay-safe confirmation, and the
 * settlement ledger tie. Adapters are controllable fakes over the
 * MOJALOOP_ADAPTER port — the stub driver itself is exercised in the
 * fail-closed cases.
 */

const ADMIN: ActorRef = { id: 'user-admin', roles: ['admin'] };

/** Controllable quote/transfer fake: scripts the switch outcome per test. */
class FakeMojaloopAdapter implements MojaloopAdapter {
  readonly name: 'simulator' | 'live' = 'simulator';
  transferOutcome: 'committed' | 'pending' | 'failed' = 'committed';
  transfers: MojaloopTransferInput[] = [];
  quotes: MojaloopQuoteInput[] = [];

  requestQuote(input: MojaloopQuoteInput): Promise<MojaloopQuote> {
    this.quotes.push(input);
    return Promise.resolve({
      quoteId: `quote-${input.reference}`,
      reference: input.reference,
      amountNaira: input.amountNaira,
      feeNaira: 0,
      status: 'received',
      source: 'fake-adapter (test fixture)'
    });
  }

  executeTransfer(input: MojaloopTransferInput): Promise<MojaloopTransfer> {
    this.transfers.push(input);
    return Promise.resolve({
      transferId: `transfer-${input.reference}`,
      reference: input.reference,
      status: this.transferOutcome,
      source: 'fake-adapter (test fixture)'
    });
  }

  status(): Promise<MojaloopAdapterStatus> {
    return Promise.resolve({ configured: true, healthy: true, detail: 'fake adapter (test fixture)' });
  }
}

/** Live-driver fake: adds the transfer-status poll and the callback seam. */
class FakeLiveAdapter extends FakeMojaloopAdapter implements LiveMojaloopAdapter {
  readonly name = 'live' as const;
  polledStatus: 'committed' | 'pending' | 'failed' = 'committed';
  callbackOutcome: 'committed' | 'pending' | 'failed' = 'committed';

  lookupParty(idType: string, idValue: string): Promise<MojaloopPartyLookup> {
    return Promise.resolve({ idType, idValue, source: 'fake-live (test fixture)' });
  }

  transferStatus(transferId: string): Promise<MojaloopTransfer> {
    return Promise.resolve({
      transferId,
      reference: transferId,
      status: this.polledStatus,
      source: 'fake-live (test fixture)'
    });
  }

  handleTransferCallback(transferId: string, _body: MojaloopTransferCallback): MojaloopTransfer {
    return {
      transferId,
      reference: transferId,
      status: this.callbackOutcome,
      source: 'fake-live callback (test fixture)'
    };
  }
}

async function makeService(adapter?: MojaloopAdapter, env: NodeJS.ProcessEnv = {}) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const users = new UsersService(createInMemoryUserRepository());
  const agents = createInMemoryAgentBankingAgentRepository();
  const vouchers = createInMemoryAgentVoucherRepository();
  const qrCodes = createInMemoryMerchantQrCodeRepository();
  const payments = createInMemoryMerchantPaymentRepository();
  const service = new DealerQrService(
    qrCodes,
    payments,
    agents,
    vouchers,
    ledger,
    users,
    events,
    adapter,
    undefined,
    env
  );
  const dealerUser = await users.create({
    phone: '+2348000000010',
    fullName: 'Dealer Danjuma',
    roles: ['agent'],
    preferredLanguage: 'en'
  });
  const farmer = await users.create({
    phone: '+2348000000011',
    fullName: 'Farmer Femi',
    roles: ['farmer'],
    preferredLanguage: 'en'
  });
  const now = new Date().toISOString();
  const dealer: AgentRecord = await agents.create({
    id: 'agent-dealer',
    userId: dealerUser.id,
    organisation: 'Mai Agro Dealer',
    status: 'ACTIVE',
    floatAccountCode: agentFloatAccountCode('agent-dealer'),
    commissionAccountCode: 'agent:agent-dealer:commission_payable',
    dailyLimitKobo: 25_000_000,
    lowFloatThresholdKobo: 0,
    createdAt: now,
    updatedAt: now
  });
  return { service, ledger, users, events, agents, vouchers, qrCodes, payments, dealerUser, farmer, dealer };
}

function actor(user: User, roles: string[] = ['farmer']): ActorRef {
  return { id: user.id, roles };
}

/** Ledger balance in kobo; 0 when the account was never provisioned. */
async function balanceKobo(ledger: LedgerService, code: string): Promise<number> {
  try {
    return (await ledger.balance(code)).balanceKobo;
  } catch (error) {
    if (error instanceof NotFoundException) {
      return 0;
    }
    throw error;
  }
}

/** Seeds a signed ISSUED voucher for the farmer, issued by a funded agent. */
async function seedVoucher(
  ctx: Awaited<ReturnType<typeof makeService>>,
  amountKobo: number,
  opts: { issuerId?: string; status?: 'ISSUED' | 'REDEEMED'; fundFloat?: boolean } = {}
) {
  const issuerId = opts.issuerId ?? 'agent-issuer';
  if (!(await ctx.agents.findById(issuerId))) {
    const issuerUser = await ctx.users.create({
      phone: '+2348000000099',
      fullName: 'Issuer Iniobong',
      roles: ['agent'],
      preferredLanguage: 'en'
    });
    const now = new Date().toISOString();
    await ctx.agents.create({
      id: issuerId,
      userId: issuerUser.id,
      organisation: 'Issuer Org',
      status: 'ACTIVE',
      floatAccountCode: agentFloatAccountCode(issuerId),
      commissionAccountCode: `agent:${issuerId}:commission_payable`,
      dailyLimitKobo: 25_000_000,
      lowFloatThresholdKobo: 0,
      createdAt: now,
      updatedAt: now
    });
  }
  if (opts.fundFloat !== false) {
    const floatCode = agentFloatAccountCode(issuerId);
    await ctx.ledger.ensureAccount({ code: floatCode, type: 'asset' });
    await ctx.ledger.ensureAccount({ code: 'platform:cash', type: 'asset' });
    await ctx.ledger.postEntry(
      {
        idempotencyKey: `seed-float:${issuerId}:${amountKobo}`,
        referenceType: 'agent_banking_float_topup',
        referenceId: `seed-${issuerId}`,
        description: 'seed float',
        postings: [
          { accountCode: floatCode, direction: 'debit', amountKobo },
          { accountCode: 'platform:cash', direction: 'credit', amountKobo }
        ]
      },
      'seed'
    );
  }
  const id = `voucher-${amountKobo}-${issuerId}`;
  const expiry = new Date(Date.now() + 3_600_000).toISOString();
  const nonce = 'nonce-seed';
  const signature = signVoucher(
    { voucherId: id, agentId: issuerId, farmerId: ctx.farmer.id, amountKobo, expiry, nonce },
    DEV_VOUCHER_SECRET
  );
  await ctx.vouchers.create({
    id,
    agentId: issuerId,
    farmerId: ctx.farmer.id,
    amountKobo,
    expiresAt: expiry,
    nonce,
    signature,
    status: opts.status ?? 'ISSUED',
    createdAt: new Date().toISOString()
  });
  return id;
}

async function issueQr(ctx: Awaited<ReturnType<typeof makeService>>, label = 'Kano shop') {
  return ctx.service.issueQrCode(ctx.dealer.id, { label }, actor(ctx.dealerUser, ['agent']));
}

describe('splitCoPayTender (co-pay split math, integer kobo)', () => {
  it('splits voucher + wallet exactly to the amount', () => {
    expect(splitCoPayTender(100_000, 40_000)).toEqual({ voucherTenderKobo: 40_000, walletTenderKobo: 60_000 });
    expect(splitCoPayTender(1, 1)).toEqual({ voucherTenderKobo: 1, walletTenderKobo: 0 });
    expect(splitCoPayTender(101, 100)).toEqual({ voucherTenderKobo: 100, walletTenderKobo: 1 });
  });

  it('treats a missing voucher as a full wallet payment', () => {
    expect(splitCoPayTender(75_000)).toEqual({ voucherTenderKobo: 0, walletTenderKobo: 75_000 });
  });

  it('rejects a voucher exceeding the amount (indivisible tender)', () => {
    expect(() => splitCoPayTender(40_000, 40_001)).toThrow(BadRequestException);
  });

  it('rejects non-positive / non-integer amounts', () => {
    expect(() => splitCoPayTender(0)).toThrow(BadRequestException);
    expect(() => splitCoPayTender(-5)).toThrow(BadRequestException);
    expect(() => splitCoPayTender(10.5)).toThrow(BadRequestException);
    expect(() => splitCoPayTender(10_000, 0)).toThrow(BadRequestException);
  });
});

describe('DealerQrService.issueQrCode', () => {
  it('issues a signed QR whose payload verifies, and emits agent_banking.qr.issued with tenant.id', async () => {
    const ctx = await makeService(new FakeMojaloopAdapter());
    const { qr, payload, signature } = await issueQr(ctx);
    expect(qr.status).toBe('active');
    expect(qr.agentOrgId).toBe(ctx.dealer.id);
    expect(
      verifyQrSignature(
        { qrId: qr.id, agentOrgId: qr.agentOrgId, dealerUserId: qr.dealerUserId, label: qr.label, issuedAt: qr.createdAt },
        signature,
        // service resolves the labelled dev secret with an empty env
        'agent-banking-dev-qr-secret-INSECURE'
      )
    ).toBe(true);
    expect(payload).toContain(qr.id);
    const outbox = await ctx.events.listOutbox();
    const issued = outbox.find((event) => event.name === 'agent_banking.qr.issued');
    expect(issued).toBeDefined();
    expect((issued?.payload as { tenantId?: string }).tenantId).toBe(`user:${ctx.dealerUser.id}`);
  });

  it('rejects labels containing the canonical separator', async () => {
    const ctx = await makeService(new FakeMojaloopAdapter());
    await expect(ctx.service.issueQrCode(ctx.dealer.id, { label: 'a.b' }, ADMIN)).rejects.toThrow(BadRequestException);
  });

  it('rejects issuance by a non-owner non-admin', async () => {
    const ctx = await makeService(new FakeMojaloopAdapter());
    await expect(
      ctx.service.issueQrCode(ctx.dealer.id, { label: 'x' }, actor(ctx.farmer))
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects issuance for a non-ACTIVE merchant', async () => {
    const ctx = await makeService(new FakeMojaloopAdapter());
    await ctx.agents.updateExpected(ctx.dealer.id, { status: 'SUSPENDED' }, { status: 'ACTIVE' });
    await expect(ctx.service.issueQrCode(ctx.dealer.id, { label: 'x' }, ADMIN)).rejects.toThrow(BadRequestException);
  });
});

describe('DealerQrService.pay — quote→transfer state machine', () => {
  it('completes a wallet-only payment off a committed transfer and settles the dealer receivable', async () => {
    const adapter = new FakeMojaloopAdapter();
    const ctx = await makeService(adapter);
    const { qr } = await issueQr(ctx);
    const payment = await ctx.service.pay(
      qr.id,
      { amountKobo: 125_000, payerAlias: '+2348000000011', idempotencyKey: 'pay-1' },
      actor(ctx.farmer)
    );
    expect(payment.status).toBe('completed');
    expect(payment.mojaloopTransferId).toBe(`transfer-${payment.id}`);
    expect(payment.walletTenderKobo).toBe(125_000);
    expect(payment.voucherTenderKobo).toBe(0);
    // Ledger tie: dealer receivable holds the full amount; the switch
    // settlement clearing account was drawn down by the same amount.
    const receivable = await ctx.ledger.balance(dealerReceivableAccountCode(ctx.dealer.id));
    expect(receivable.balanceKobo).toBe(125_000);
    const settlement = await ctx.ledger.balance(PLATFORM_MOJALOOP_SETTLEMENT_ACCOUNT);
    expect(settlement.balanceKobo).toBe(-125_000);
    expect(payment.ledgerEntryId).toBeDefined();
    const outbox = await ctx.events.listOutbox();
    const names = outbox.map((event) => event.name);
    expect(names).toContain('agent_banking.merchant_payment.quoted');
    expect(names).toContain('agent_banking.merchant_payment.completed');
    const completed = outbox.find((event) => event.name === 'agent_banking.merchant_payment.completed');
    expect((completed?.payload as { tenantId?: string }).tenantId).toBe(`user:${ctx.farmer.id}`);
  });

  it('replays the same idempotency key without a second transfer or posting', async () => {
    const adapter = new FakeMojaloopAdapter();
    const ctx = await makeService(adapter);
    const { qr } = await issueQr(ctx);
    const input = { amountKobo: 50_000, payerAlias: '+2348000000011', idempotencyKey: 'pay-replay' };
    const first = await ctx.service.pay(qr.id, input, actor(ctx.farmer));
    const second = await ctx.service.pay(qr.id, input, actor(ctx.farmer));
    expect(second.id).toBe(first.id);
    expect(adapter.transfers).toHaveLength(1);
    const receivable = await ctx.ledger.balance(dealerReceivableAccountCode(ctx.dealer.id));
    expect(receivable.balanceKobo).toBe(50_000);
  });

  it('keeps a pending transfer quoted and settles it via the confirmation poller', async () => {
    const adapter = new FakeLiveAdapter();
    adapter.transferOutcome = 'pending';
    adapter.polledStatus = 'committed';
    const ctx = await makeService(adapter);
    const { qr } = await issueQr(ctx);
    const payment = await ctx.service.pay(
      qr.id,
      { amountKobo: 80_000, payerAlias: '+2348000000011', idempotencyKey: 'pay-pending' },
      actor(ctx.farmer)
    );
    expect(payment.status).toBe('quoted');
    expect(await balanceKobo(ctx.ledger, dealerReceivableAccountCode(ctx.dealer.id))).toBe(0);
    const confirmed = await ctx.service.confirmPayment(payment.id, ADMIN.id);
    expect(confirmed.status).toBe('completed');
    // Poller replay is a no-op (still one settlement posting).
    const again = await ctx.service.confirmPayment(payment.id, ADMIN.id);
    expect(again.status).toBe('completed');
    expect(again.ledgerEntryId).toBe(confirmed.ledgerEntryId);
    const receivable = await ctx.ledger.balance(dealerReceivableAccountCode(ctx.dealer.id));
    expect(receivable.balanceKobo).toBe(80_000);
  });

  it('keeps a still-pending poll quoted', async () => {
    const adapter = new FakeLiveAdapter();
    adapter.transferOutcome = 'pending';
    adapter.polledStatus = 'pending';
    const ctx = await makeService(adapter);
    const { qr } = await issueQr(ctx);
    const payment = await ctx.service.pay(
      qr.id,
      { amountKobo: 80_000, payerAlias: '+2348000000011', idempotencyKey: 'pay-still-pending' },
      actor(ctx.farmer)
    );
    const polled = await ctx.service.confirmPayment(payment.id, ADMIN.id);
    expect(polled.status).toBe('quoted');
  });

  it('marks the payment failed when the switch aborts the transfer', async () => {
    const adapter = new FakeMojaloopAdapter();
    adapter.transferOutcome = 'failed';
    const ctx = await makeService(adapter);
    const { qr } = await issueQr(ctx);
    const payment = await ctx.service.pay(
      qr.id,
      { amountKobo: 60_000, payerAlias: '+2348000000011', idempotencyKey: 'pay-fail' },
      actor(ctx.farmer)
    );
    expect(payment.status).toBe('failed');
    expect(payment.failureReason).toContain('aborted');
    const outbox = await ctx.events.listOutbox();
    expect(outbox.map((event) => event.name)).toContain('agent_banking.merchant_payment.failed');
    expect(await balanceKobo(ctx.ledger, dealerReceivableAccountCode(ctx.dealer.id))).toBe(0);
  });
});

describe('DealerQrService.pay — co-pay (voucher + wallet = amount)', () => {
  it('settles voucher tender from the issuer float and wallet tender from the switch', async () => {
    const adapter = new FakeMojaloopAdapter();
    const ctx = await makeService(adapter);
    const voucherId = await seedVoucher(ctx, 40_000);
    const { qr } = await issueQr(ctx);
    const payment = await ctx.service.pay(
      qr.id,
      { amountKobo: 100_000, payerAlias: '+2348000000011', voucherId, idempotencyKey: 'pay-copay' },
      actor(ctx.farmer)
    );
    expect(payment.status).toBe('completed');
    // Co-pay split invariant: voucher + wallet = amount (integer kobo).
    expect(payment.voucherTenderKobo + payment.walletTenderKobo).toBe(payment.amountKobo);
    expect(payment.voucherTenderKobo).toBe(40_000);
    expect(payment.walletTenderKobo).toBe(60_000);
    // The switch leg moved exactly the wallet tender (kobo → naira at the port).
    expect(adapter.transfers).toHaveLength(1);
    expect(adapter.transfers[0].amountNaira).toBe(600);
    // Ledger ties: dealer receivable = full amount; issuer float down by the
    // voucher tender; settlement clearing down by the wallet tender.
    expect(await balanceKobo(ctx.ledger, dealerReceivableAccountCode(ctx.dealer.id))).toBe(100_000);
    expect(await balanceKobo(ctx.ledger, agentFloatAccountCode('agent-issuer'))).toBe(0);
    expect(await balanceKobo(ctx.ledger, PLATFORM_MOJALOOP_SETTLEMENT_ACCOUNT)).toBe(-60_000);
    // The voucher finalized REDEEMED, pinned to the settlement entry.
    const voucher = await ctx.vouchers.findById(voucherId);
    expect(voucher?.status).toBe('REDEEMED');
    expect(voucher?.ledgerEntryId).toBe(payment.ledgerEntryId);
  });

  it('completes a voucher-only payment with no Mojaloop call', async () => {
    const adapter = new FakeMojaloopAdapter();
    const ctx = await makeService(adapter);
    const voucherId = await seedVoucher(ctx, 55_000);
    const { qr } = await issueQr(ctx);
    const payment = await ctx.service.pay(
      qr.id,
      { amountKobo: 55_000, payerAlias: '+2348000000011', voucherId, idempotencyKey: 'pay-voucher-only' },
      actor(ctx.farmer)
    );
    expect(payment.status).toBe('completed');
    expect(payment.walletTenderKobo).toBe(0);
    expect(payment.mojaloopTransferId).toBeUndefined();
    expect(adapter.quotes).toHaveLength(0);
    expect(adapter.transfers).toHaveLength(0);
    expect(await balanceKobo(ctx.ledger, dealerReceivableAccountCode(ctx.dealer.id))).toBe(55_000);
  });

  it('rejects co-pay with a voucher exceeding the amount', async () => {
    const ctx = await makeService(new FakeMojaloopAdapter());
    const voucherId = await seedVoucher(ctx, 70_000);
    const { qr } = await issueQr(ctx);
    await expect(
      ctx.service.pay(
        qr.id,
        { amountKobo: 60_000, payerAlias: '+2348000000011', voucherId, idempotencyKey: 'pay-over' },
        actor(ctx.farmer)
      )
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects co-pay with someone else’s voucher', async () => {
    const ctx = await makeService(new FakeMojaloopAdapter());
    const voucherId = await seedVoucher(ctx, 10_000);
    const { qr } = await issueQr(ctx);
    const other = await ctx.users.create({
      phone: '+2348000000042',
      fullName: 'Farmer Funke',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    await expect(
      ctx.service.pay(
        qr.id,
        { amountKobo: 10_000, payerAlias: '+2348000000042', voucherId, idempotencyKey: 'pay-not-mine' },
        actor(other)
      )
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects co-pay with an already-REDEEMED voucher', async () => {
    const ctx = await makeService(new FakeMojaloopAdapter());
    const voucherId = await seedVoucher(ctx, 10_000, { status: 'REDEEMED' });
    const { qr } = await issueQr(ctx);
    await expect(
      ctx.service.pay(
        qr.id,
        { amountKobo: 10_000, payerAlias: '+2348000000011', voucherId, idempotencyKey: 'pay-redeemed' },
        actor(ctx.farmer)
      )
    ).rejects.toThrow(ConflictException);
  });

  it('rejects co-pay with a tampered voucher signature', async () => {
    const ctx = await makeService(new FakeMojaloopAdapter());
    const voucherId = await seedVoucher(ctx, 10_000);
    const { qr } = await issueQr(ctx);
    // Tamper: rewrite the stored signature so the payload no longer verifies.
    await ctx.vouchers.updateExpected(voucherId, { status: 'ISSUED' }, { status: 'ISSUED' });
    const stored = await ctx.vouchers.findById(voucherId);
    expect(stored).toBeDefined();
    const tampered = { ...stored!, signature: '0'.repeat(64) };
    // In-memory repo has no generic update; re-seed via updateExpected is
    // field-limited, so emulate the tamper with a fresh bad-signature row.
    await ctx.vouchers.create({
      id: 'voucher-tampered',
      agentId: stored!.agentId,
      farmerId: ctx.farmer.id,
      amountKobo: 10_000,
      expiresAt: stored!.expiresAt,
      nonce: 'nonce-bad',
      signature: tampered.signature,
      status: 'ISSUED',
      createdAt: new Date().toISOString()
    });
    await expect(
      ctx.service.pay(
        qr.id,
        { amountKobo: 10_000, payerAlias: '+2348000000011', voucherId: 'voucher-tampered', idempotencyKey: 'pay-tampered' },
        actor(ctx.farmer)
      )
    ).rejects.toThrow(UnauthorizedException);
  });

  it('fails the co-pay payment and releases the voucher claim when the switch aborts', async () => {
    const adapter = new FakeMojaloopAdapter();
    adapter.transferOutcome = 'failed';
    const ctx = await makeService(adapter);
    const voucherId = await seedVoucher(ctx, 40_000);
    const { qr } = await issueQr(ctx);
    const payment = await ctx.service.pay(
      qr.id,
      { amountKobo: 100_000, payerAlias: '+2348000000011', voucherId, idempotencyKey: 'pay-copay-fail' },
      actor(ctx.farmer)
    );
    expect(payment.status).toBe('failed');
    // The voucher claim rolled back (the ledger probe proved no settlement).
    expect((await ctx.vouchers.findById(voucherId))?.status).toBe('ISSUED');
    expect(await balanceKobo(ctx.ledger, dealerReceivableAccountCode(ctx.dealer.id))).toBe(0);
  });

  it('refuses the voucher leg when the issuer float cannot cover it (solvency guard)', async () => {
    const ctx = await makeService(new FakeMojaloopAdapter());
    const voucherId = await seedVoucher(ctx, 40_000, { fundFloat: false });
    // Fund below the voucher face value.
    const floatCode = agentFloatAccountCode('agent-issuer');
    await ctx.ledger.ensureAccount({ code: floatCode, type: 'asset' });
    await ctx.ledger.ensureAccount({ code: 'platform:cash', type: 'asset' });
    await ctx.ledger.postEntry(
      {
        idempotencyKey: 'seed-float-underfunded',
        referenceType: 'agent_banking_float_topup',
        referenceId: 'seed-underfunded',
        description: 'seed float (underfunded)',
        postings: [
          { accountCode: floatCode, direction: 'debit', amountKobo: 39_999 },
          { accountCode: 'platform:cash', direction: 'credit', amountKobo: 39_999 }
        ]
      },
      'seed'
    );
    const { qr } = await issueQr(ctx);
    await expect(
      ctx.service.pay(
        qr.id,
        { amountKobo: 100_000, payerAlias: '+2348000000011', voucherId, idempotencyKey: 'pay-insolvent' },
        actor(ctx.farmer)
      )
    ).rejects.toThrow();
    // Nothing settled: the voucher claim stays REDEEMING for a safe resume
    // (the ledger probe cannot prove absence — the wallet leg committed at
    // the fake switch first), and no dealer receivable was posted.
    expect(await balanceKobo(ctx.ledger, dealerReceivableAccountCode(ctx.dealer.id))).toBe(0);
  });
});

describe('DealerQrService — fail-closed adapter gating', () => {
  it('never completes a payment off the stub adapter (simulated transfer stays quoted)', async () => {
    const ctx = await makeService(new StubMojaloopAdapter());
    const { qr } = await issueQr(ctx);
    const payment = await ctx.service.pay(
      qr.id,
      { amountKobo: 20_000, payerAlias: '+2348000000011', idempotencyKey: 'pay-stub' },
      actor(ctx.farmer)
    );
    expect(payment.status).toBe('quoted');
    expect(payment.adapterBasis).toBe('stub');
    expect(await balanceKobo(ctx.ledger, dealerReceivableAccountCode(ctx.dealer.id))).toBe(0);
  });

  it('answers 503 in production with the stub adapter', async () => {
    const prodEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      AGENT_QR_SECRET: 'prod-qr-secret-0123456789abcdef0123456789',
      AGENT_VOUCHER_SECRET: 'prod-voucher-secret-0123456789abcdef0123'
    };
    const ctx = await makeService(new StubMojaloopAdapter(), prodEnv);
    const { qr } = await issueQr(ctx);
    await expect(
      ctx.service.pay(
        qr.id,
        { amountKobo: 20_000, payerAlias: '+2348000000011', idempotencyKey: 'pay-prod-stub' },
        actor(ctx.farmer)
      )
    ).rejects.toThrow(ServiceUnavailableException);
    // Nothing was persisted: no payment row under the key.
    expect(await ctx.payments.findByIdempotencyKey('pay-prod-stub')).toBeUndefined();
  });

  it('answers 503 for the wallet leg when no adapter is bound', async () => {
    const ctx = await makeService(undefined);
    const { qr } = await issueQr(ctx);
    await expect(
      ctx.service.pay(
        qr.id,
        { amountKobo: 20_000, payerAlias: '+2348000000011', idempotencyKey: 'pay-no-adapter' },
        actor(ctx.farmer)
      )
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('confirmation polling requires the live driver (503 on stub)', async () => {
    const ctx = await makeService(new StubMojaloopAdapter());
    const { qr } = await issueQr(ctx);
    const payment = await ctx.service.pay(
      qr.id,
      { amountKobo: 20_000, payerAlias: '+2348000000011', idempotencyKey: 'pay-stub-confirm' },
      actor(ctx.farmer)
    );
    await expect(ctx.service.confirmPayment(payment.id, ADMIN.id)).rejects.toThrow(ServiceUnavailableException);
  });
});

describe('DealerQrService — webhook (replay-safe settlement)', () => {
  it('settles on a committed callback and treats redelivery as a no-op', async () => {
    const adapter = new FakeLiveAdapter();
    adapter.transferOutcome = 'pending';
    const ctx = await makeService(adapter);
    const { qr } = await issueQr(ctx);
    const payment = await ctx.service.pay(
      qr.id,
      { amountKobo: 90_000, payerAlias: '+2348000000011', idempotencyKey: 'pay-webhook' },
      actor(ctx.farmer)
    );
    expect(payment.status).toBe('quoted');
    const transferId = payment.mojaloopTransferId as string;
    const settled = await ctx.service.handleMojaloopWebhook({ transferId, transferState: 'COMMITTED' });
    expect(settled.status).toBe('completed');
    // Redelivered confirmation: no-op, same row, no double settlement.
    const redelivered = await ctx.service.handleMojaloopWebhook({ transferId, transferState: 'COMMITTED' });
    expect(redelivered.status).toBe('completed');
    expect(redelivered.ledgerEntryId).toBe(settled.ledgerEntryId);
    expect(await balanceKobo(ctx.ledger, dealerReceivableAccountCode(ctx.dealer.id))).toBe(90_000);
    const outbox = await ctx.events.listOutbox();
    expect(outbox.filter((event) => event.name === 'agent_banking.merchant_payment.completed')).toHaveLength(1);
  });

  it('fails the payment on an aborted callback', async () => {
    const adapter = new FakeLiveAdapter();
    adapter.transferOutcome = 'pending';
    adapter.callbackOutcome = 'failed';
    const ctx = await makeService(adapter);
    const { qr } = await issueQr(ctx);
    const payment = await ctx.service.pay(
      qr.id,
      { amountKobo: 90_000, payerAlias: '+2348000000011', idempotencyKey: 'pay-webhook-abort' },
      actor(ctx.farmer)
    );
    const failed = await ctx.service.handleMojaloopWebhook({
      transferId: payment.mojaloopTransferId as string,
      transferState: 'ABORTED'
    });
    expect(failed.status).toBe('failed');
  });

  it('rejects callbacks for unknown transfers (404) and non-live drivers (503)', async () => {
    const live = await makeService(new FakeLiveAdapter());
    await expect(
      live.service.handleMojaloopWebhook({ transferId: 'transfer-unknown', transferState: 'COMMITTED' })
    ).rejects.toThrow(NotFoundException);
    const stub = await makeService(new StubMojaloopAdapter());
    await expect(
      stub.service.handleMojaloopWebhook({ transferId: 'transfer-x', transferState: 'COMMITTED' })
    ).rejects.toThrow(ServiceUnavailableException);
  });
});

describe('DealerQrService — QR integrity and access control', () => {
  it('refuses payment against a tampered QR row (payload HMAC no longer verifies)', async () => {
    const ctx = await makeService(new FakeMojaloopAdapter());
    const { qr } = await issueQr(ctx);
    // Tamper at the persistence layer: rebind the code to another dealer.
    await ctx.qrCodes.updateExpected(qr.id, { status: 'active' }, { status: 'active' });
    const stored = await ctx.qrCodes.findById(qr.id);
    // In-memory repo field-limited CAS cannot rewrite dealerUserId, so seed
    // a directly-tampered row instead (pg path is covered by the pg spec).
    await ctx.qrCodes.create({
      id: 'qr-tampered',
      agentOrgId: stored!.agentOrgId,
      dealerUserId: ctx.farmer.id,
      payloadHmac: stored!.payloadHmac,
      label: stored!.label,
      status: 'active',
      createdAt: stored!.createdAt
    });
    await expect(
      ctx.service.pay(
        'qr-tampered',
        { amountKobo: 10_000, payerAlias: '+2348000000011', idempotencyKey: 'pay-tampered-qr' },
        actor(ctx.farmer)
      )
    ).rejects.toThrow(UnauthorizedException);
  });

  it('refuses payment against a revoked QR code', async () => {
    const ctx = await makeService(new FakeMojaloopAdapter());
    const { qr } = await issueQr(ctx);
    await ctx.qrCodes.updateExpected(qr.id, { status: 'revoked' }, { status: 'active' });
    await expect(
      ctx.service.pay(
        qr.id,
        { amountKobo: 10_000, payerAlias: '+2348000000011', idempotencyKey: 'pay-revoked' },
        actor(ctx.farmer)
      )
    ).rejects.toThrow(ConflictException);
  });

  it('requires an idempotency key (400 when missing)', async () => {
    const ctx = await makeService(new FakeMojaloopAdapter());
    const { qr } = await issueQr(ctx);
    await expect(
      ctx.service.pay(qr.id, { amountKobo: 10_000, payerAlias: '+2348000000011', idempotencyKey: '' }, actor(ctx.farmer))
    ).rejects.toThrow(BadRequestException);
  });

  it('getPayment allows payer, dealer and admin but not a stranger', async () => {
    const ctx = await makeService(new FakeMojaloopAdapter());
    const { qr } = await issueQr(ctx);
    const payment = await ctx.service.pay(
      qr.id,
      { amountKobo: 10_000, payerAlias: '+2348000000011', idempotencyKey: 'pay-acl' },
      actor(ctx.farmer)
    );
    expect((await ctx.service.getPayment(payment.id, actor(ctx.farmer))).id).toBe(payment.id);
    expect((await ctx.service.getPayment(payment.id, actor(ctx.dealerUser, ['agent']))).id).toBe(payment.id);
    expect((await ctx.service.getPayment(payment.id, ADMIN)).id).toBe(payment.id);
    const stranger = await ctx.users.create({
      phone: '+2348000000077',
      fullName: 'Stranger Sadiq',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    await expect(ctx.service.getPayment(payment.id, actor(stranger))).rejects.toThrow(ForbiddenException);
  });

  it('exposes the rollout flag key', () => {
    expect(DEALER_QR_PAY_FLAG).toBe('dealer-qr-pay');
  });
});

describe('DealerQrService — expired voucher co-pay', () => {
  it('rejects an expired voucher with 410 before any state change', async () => {
    const ctx = await makeService(new FakeMojaloopAdapter());
    const issuerId = 'agent-issuer';
    await seedVoucher(ctx, 10_000);
    const expiredId = 'voucher-expired';
    const expiry = new Date(Date.now() - 1_000).toISOString();
    const signature = signVoucher(
      { voucherId: expiredId, agentId: issuerId, farmerId: ctx.farmer.id, amountKobo: 10_000, expiry, nonce: 'n1' },
      DEV_VOUCHER_SECRET
    );
    await ctx.vouchers.create({
      id: expiredId,
      agentId: issuerId,
      farmerId: ctx.farmer.id,
      amountKobo: 10_000,
      expiresAt: expiry,
      nonce: 'n1',
      signature,
      status: 'ISSUED',
      createdAt: new Date().toISOString()
    });
    const { qr } = await issueQr(ctx);
    await expect(
      ctx.service.pay(
        qr.id,
        { amountKobo: 10_000, payerAlias: '+2348000000011', voucherId: expiredId, idempotencyKey: 'pay-expired' },
        actor(ctx.farmer)
      )
    ).rejects.toThrow(GoneException);
    expect(await ctx.payments.findByIdempotencyKey('pay-expired')).toBeUndefined();
  });
});
