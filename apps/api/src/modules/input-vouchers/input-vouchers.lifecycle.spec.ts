import {
  ConflictException,
  UnprocessableEntityException
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryBeneficiaryRepository,
  createInMemoryInputVoucherRepository,
  createInMemoryProgrammeFundingRepository,
  createInMemoryRedemptionRepository,
  createInMemorySubsidyProgrammeRepository
} from '../../database/repositories/input-vouchers.repository.js';
import type { LedgerJournalEntry } from '@agric-platform/shared';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { UsersService } from '../users/users.service.js';
import { StubIdentityDriver, stubIdentityResult } from './identity.driver.js';
import {
  InputVouchersService,
  programmeLiabilityAccountCode,
  supplierReceivableAccountCode,
  type ActorRef
} from './input-vouchers.service.js';

const ADMIN: ActorRef = { id: 'user-admin', roles: ['admin'] };

function verifiedNin(start: number): string {
  for (let candidate = start; candidate < 99999999999; candidate += 1) {
    const nin = String(candidate).padStart(11, '0');
    if (stubIdentityResult(nin).verified) {
      return nin;
    }
  }
  throw new Error('no verifiable stub NIN found');
}

async function makeService() {
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const ledgerEntries = createInMemoryLedgerEntryRepository();
  const ledger = new LedgerService(events, createInMemoryLedgerAccountRepository(), ledgerEntries);
  const users = new UsersService(createInMemoryUserRepository());
  const programmes = createInMemorySubsidyProgrammeRepository();
  const vouchers = createInMemoryInputVoucherRepository();
  const redemptions = createInMemoryRedemptionRepository();
  const funding = createInMemoryProgrammeFundingRepository();
  const service = new InputVouchersService(
    programmes,
    createInMemoryBeneficiaryRepository(),
    vouchers,
    redemptions,
    funding,
    ledger,
    users,
    events,
    new StubIdentityDriver(),
    undefined,
    {}
  );
  const farmer = await users.create({
    phone: '+2348000000002',
    fullName: 'Farmer Femi',
    roles: ['farmer'],
    preferredLanguage: 'en'
  });
  const supplier = await users.create({
    phone: '+2348000000004',
    fullName: 'Dealer Dapo',
    roles: ['supplier'],
    preferredLanguage: 'en'
  });
  return { service, ledger, ledgerEntries, events, farmer, supplier, programmes, vouchers, redemptions, funding };
}

type Ctx = Awaited<ReturnType<typeof makeService>>;

let ninSeed = 10000000000;

async function allocatedVoucher(ctx: Ctx, amountKobo = 200_000, expiresAt?: string) {
  ninSeed += 137;
  const programme = await ctx.service.createProgramme(
    { name: 'P', sponsor: 'S (STUB demo)', perFarmerCapKobo: 500_000, budgetKobo: 2_000_000 },
    ADMIN.id
  );
  const activated = await ctx.service.activateProgramme(programme.id, ADMIN.id);
  await ctx.service.fundProgramme(
    activated.id,
    { amountKobo: 2_000_000, idempotencyKey: `fund-${activated.id}` },
    ADMIN.id
  );
  await ctx.service.verifyBeneficiary(
    activated.id,
    {
      farmerId: ctx.farmer.id,
      nin: verifiedNin(ninSeed),
      fullName: 'Farmer Femi',
      state: 'Kano',
      primaryCrop: 'maize'
    },
    ADMIN.id
  );
  const voucher = await ctx.service.allocateVoucher(
    activated.id,
    { farmerId: ctx.farmer.id, amountKobo, idempotencyKey: `alloc-${ninSeed}`, expiresAt },
    ADMIN.id
  );
  await ctx.service.distributeVoucher(voucher.id, ADMIN.id);
  return { programme: activated, voucher };
}

async function ledgerEntriesOf(ctx: Ctx): Promise<LedgerJournalEntry[]> {
  return ctx.ledgerEntries.find({});
}

async function liabilityBalance(ctx: Ctx, programmeId: string): Promise<number> {
  const balance = await ctx.ledger.balance(programmeLiabilityAccountCode(programmeId));
  return balance.creditsKobo - balance.debitsKobo;
}

describe('InputVouchersService — W2-C2 V-32 partial redemption (balance-bearing vouchers)', () => {
  it('redeems a voucher in two parts summing to the face value', async () => {
    const ctx = await makeService();
    const { programme, voucher } = await allocatedVoucher(ctx);

    const part1 = await ctx.service.redeemVoucher(
      voucher.id,
      'INV-1',
      { id: ctx.supplier.id, roles: ['supplier'] },
      { amountKobo: 80_000 }
    );
    expect(part1.voucher.status).toBe('PARTIALLY_REDEEMED');
    expect(part1.voucher.redeemedAmountKobo).toBe(80_000);
    expect(part1.redemption.partSeq).toBe(1);

    const part2 = await ctx.service.redeemVoucher(
      voucher.id,
      'INV-2',
      { id: ctx.supplier.id, roles: ['supplier'] },
      { amountKobo: 120_000 }
    );
    expect(part2.voucher.status).toBe('REDEEMED');
    expect(part2.voucher.redeemedAmountKobo).toBe(200_000);
    expect(part2.redemption.partSeq).toBe(2);

    // Each part has its own balanced leg pair against the programme liability.
    expect(await liabilityBalance(ctx, programme.id)).toBe(2_000_000 - 200_000);
    const receivable = await ctx.ledger.balance(supplierReceivableAccountCode(ctx.supplier.id));
    expect(receivable.creditsKobo - receivable.debitsKobo).toBe(200_000);
    // The float reservation settled per part.
    const funding = await ctx.funding.getFunding(programme.id);
    expect(funding?.reservedKobo).toBe(0);
    expect(funding?.settledKobo).toBe(200_000);
    // Reconciliation still ties.
    const recon = await ctx.service.reconciliation(programme.id);
    expect(recon.ledger.discrepancyKobo).toBe(0);
  });

  it('omitting amountKobo redeems the full remaining balance (legacy behaviour)', async () => {
    const ctx = await makeService();
    const { voucher } = await allocatedVoucher(ctx);
    const settled = await ctx.service.redeemVoucher(voucher.id, 'INV-1', { id: ctx.supplier.id, roles: ['supplier'] });
    expect(settled.voucher.status).toBe('REDEEMED');
    expect(settled.redemption.amountKobo).toBe(200_000);
    expect(settled.redemption.partSeq).toBe(1);
  });

  it('rejects an overshoot of the remaining balance with 422 and claims nothing', async () => {
    const ctx = await makeService();
    const { voucher } = await allocatedVoucher(ctx);
    await ctx.service.redeemVoucher(
      voucher.id,
      'INV-1',
      { id: ctx.supplier.id, roles: ['supplier'] },
      { amountKobo: 150_000 }
    );
    await expect(
      ctx.service.redeemVoucher(
        voucher.id,
        'INV-2',
        { id: ctx.supplier.id, roles: ['supplier'] },
        { amountKobo: 60_000 } // remaining is 50_000
      )
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    const after = await ctx.service.getVoucher(voucher.id);
    expect(after.status).toBe('PARTIALLY_REDEEMED');
    expect(after.redeemedAmountKobo).toBe(150_000);
    // Exactly one redemption entry was ever posted.
    const entries = await ledgerEntriesOf(ctx);
    expect(entries.filter((entry) => entry.referenceType === 'input_voucher_redemption')).toHaveLength(1);
  });

  it('two concurrent partial redemptions: exactly one wins the claim (no over-redemption)', async () => {
    const ctx = await makeService();
    const { voucher } = await allocatedVoucher(ctx);
    const supplier: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    const results = await Promise.allSettled([
      ctx.service.redeemVoucher(voucher.id, 'INV-A', supplier, { amountKobo: 120_000 }),
      ctx.service.redeemVoucher(voucher.id, 'INV-B', supplier, { amountKobo: 120_000 })
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const after = await ctx.service.getVoucher(voucher.id);
    expect(after.redeemedAmountKobo).toBe(120_000);
    // The balance stays consistent: face 200_000 - redeemed 120_000 remains spendable.
    const part2 = await ctx.service.redeemVoucher(voucher.id, 'INV-C', supplier, { amountKobo: 80_000 });
    expect(part2.voucher.status).toBe('REDEEMED');
    expect((await ledgerEntriesOf(ctx)).filter((entry) => entry.referenceType === 'input_voucher_redemption')).toHaveLength(2);
  });

  it('expires a partially redeemed voucher and releases only the remaining balance', async () => {
    const ctx = await makeService();
    const { programme, voucher } = await allocatedVoucher(ctx, 200_000, new Date(Date.now() + 30).toISOString());
    await ctx.service.redeemVoucher(
      voucher.id,
      'INV-1',
      { id: ctx.supplier.id, roles: ['supplier'] },
      { amountKobo: 50_000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    const expired = await ctx.service.expireVoucher(voucher.id, ADMIN.id);
    expect(expired.status).toBe('EXPIRED');
    // Liability: budget 2M - redeemed 50k - released 150k.
    expect(await liabilityBalance(ctx, programme.id)).toBe(2_000_000 - 50_000 - 150_000);
    const funding = await ctx.funding.getFunding(programme.id);
    expect(funding?.reservedKobo).toBe(0);
    expect(funding?.settledKobo).toBe(50_000);
    const recon = await ctx.service.reconciliation(programme.id);
    expect(recon.ledger.discrepancyKobo).toBe(0);
    expect(recon.totals.expiredKobo).toBe(150_000);
  });
});

describe('InputVouchersService — W2-C2 V-02 refund / reversal of redeemed vouchers', () => {
  it('refunds a fully redeemed voucher: balanced reversal, budget restored, complaint linked', async () => {
    const ctx = await makeService();
    const { programme, voucher } = await allocatedVoucher(ctx);
    await ctx.service.redeemVoucher(voucher.id, 'INV-1', { id: ctx.supplier.id, roles: ['supplier'] });

    const refunded = await ctx.service.refundVoucher(voucher.id, ADMIN.id, {
      reason: 'Counterfeit fertiliser batch confirmed',
      complaintCaseId: 'complaint-77'
    });
    expect(refunded.status).toBe('REFUNDED');
    expect(refunded.refundedAmountKobo).toBe(200_000);
    expect(refunded.complaintCaseId).toBe('complaint-77');
    expect(refunded.refundReason).toContain('Counterfeit');

    // Compensating entry: exact inverse of the redemption (liability credited
    // back, supplier receivable clawed back = dealer-settlement clawback).
    const reversals = (await ledgerEntriesOf(ctx)).filter(
      (entry) => entry.reversesEntryId !== undefined
    );
    expect(reversals).toHaveLength(1);
    const debit = reversals[0].postings.find((posting: { direction: string; accountCode: string; amountKobo: number }) => posting.direction === 'debit');
    const credit = reversals[0].postings.find((posting: { direction: string; accountCode: string; amountKobo: number }) => posting.direction === 'credit');
    expect(debit?.accountCode).toBe(supplierReceivableAccountCode(ctx.supplier.id));
    expect(credit?.accountCode).toBe(programmeLiabilityAccountCode(programme.id));
    expect(debit?.amountKobo).toBe(200_000);
    expect(credit?.amountKobo).toBe(200_000);

    // Balanced: the face value returned to the budget (release entry), the
    // supplier nets zero; the liability holds budget - face again.
    expect(await liabilityBalance(ctx, programme.id)).toBe(2_000_000 - 200_000);
    const receivable = await ctx.ledger.balance(supplierReceivableAccountCode(ctx.supplier.id));
    expect(receivable.creditsKobo - receivable.debitsKobo).toBe(0);
    // Settled float returned to the programme.
    const funding = await ctx.funding.getFunding(programme.id);
    expect(funding?.settledKobo).toBe(0);
    const recon = await ctx.service.reconciliation(programme.id);
    expect(recon.ledger.discrepancyKobo).toBe(0);
    expect(recon.totals.refundedCount).toBe(1);
    expect(recon.totals.refundedKobo).toBe(200_000);
  });

  it('refund replay is idempotent: a second refund reposts nothing', async () => {
    const ctx = await makeService();
    const { voucher } = await allocatedVoucher(ctx);
    await ctx.service.redeemVoucher(voucher.id, 'INV-1', { id: ctx.supplier.id, roles: ['supplier'] });
    await ctx.service.refundVoucher(voucher.id, ADMIN.id, { reason: 'r' });
    const entriesBefore = (await ledgerEntriesOf(ctx)).length;
    const replay = await ctx.service.refundVoucher(voucher.id, ADMIN.id, { reason: 'r' });
    expect(replay.status).toBe('REFUNDED');
    expect((await ledgerEntriesOf(ctx)).length).toBe(entriesBefore);
  });

  it('a stuck REFUNDING claim resumes to REFUNDED without double-reversing', async () => {
    const ctx = await makeService();
    const { voucher } = await allocatedVoucher(ctx);
    await ctx.service.redeemVoucher(voucher.id, 'INV-1', { id: ctx.supplier.id, roles: ['supplier'] });
    // Simulate the crash window: claim taken, nothing posted yet.
    await ctx.vouchers.updateExpected(
      voucher.id,
      { status: 'REFUNDING', refundReason: 'crash', complaintCaseId: 'complaint-9' },
      { status: 'REDEEMED' }
    );
    const resumed = await ctx.service.refundVoucher(voucher.id, ADMIN.id);
    expect(resumed.status).toBe('REFUNDED');
    expect(resumed.refundReason).toBe('crash'); // stored claim parameters adopted
    expect(resumed.complaintCaseId).toBe('complaint-9');
    const reversals = (await ledgerEntriesOf(ctx)).filter(
      (entry) => entry.reversesEntryId !== undefined
    );
    expect(reversals).toHaveLength(1); // exactly one inverse entry
    await expect(ctx.service.redeemVoucher(voucher.id, 'INV-2', { id: ctx.supplier.id, roles: ['supplier'] })).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('refunding a partially redeemed voucher reverses the parts and releases the remainder', async () => {
    const ctx = await makeService();
    const { programme, voucher } = await allocatedVoucher(ctx);
    await ctx.service.redeemVoucher(
      voucher.id,
      'INV-1',
      { id: ctx.supplier.id, roles: ['supplier'] },
      { amountKobo: 70_000 }
    );
    const refunded = await ctx.service.refundVoucher(voucher.id, ADMIN.id, { reason: 'spoiled inputs' });
    expect(refunded.status).toBe('REFUNDED');
    expect(refunded.refundedAmountKobo).toBe(70_000);
    // Liability: budget 2M - face 200k released (reversal restores the part,
    // then the full face releases to budget — the expiry terminal state).
    expect(await liabilityBalance(ctx, programme.id)).toBe(2_000_000 - 200_000);
    const funding = await ctx.funding.getFunding(programme.id);
    expect(funding?.reservedKobo).toBe(0);
    expect(funding?.settledKobo).toBe(0);
    const recon = await ctx.service.reconciliation(programme.id);
    expect(recon.ledger.discrepancyKobo).toBe(0);
  });

  it('rejects refunding a voucher that was never redeemed', async () => {
    const ctx = await makeService();
    const { voucher } = await allocatedVoucher(ctx);
    await expect(ctx.service.refundVoucher(voucher.id, ADMIN.id, {})).rejects.toBeInstanceOf(ConflictException);
  });
});
