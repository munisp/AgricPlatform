import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
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
  PLATFORM_SUBSIDY_BUDGET_ACCOUNT,
  programmeLiabilityAccountCode,
  supplierReceivableAccountCode,
  type ActorRef
} from './input-vouchers.service.js';

const ADMIN: ActorRef = { id: 'user-admin', roles: ['admin'] };

/** Deterministically finds a NIN the stub driver verifies. */
function verifiedNin(start: number): string {
  for (let candidate = start; candidate < 99999999999; candidate += 1) {
    const nin = String(candidate).padStart(11, '0');
    if (stubIdentityResult(nin).verified) {
      return nin;
    }
  }
  throw new Error('no verifiable stub NIN found');
}

/** Deterministically finds a NIN the stub driver rejects. */
function rejectedNin(start: number): string {
  for (let candidate = start; candidate < 99999999999; candidate += 1) {
    const nin = String(candidate).padStart(11, '0');
    if (!stubIdentityResult(nin).verified) {
      return nin;
    }
  }
  throw new Error('no rejectable stub NIN found');
}

async function makeService() {
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
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
  const farmerTwo = await users.create({
    phone: '+2348000000003',
    fullName: 'Farmer Funke',
    roles: ['farmer'],
    preferredLanguage: 'en'
  });
  const supplier = await users.create({
    phone: '+2348000000004',
    fullName: 'Dealer Dapo',
    roles: ['supplier'],
    preferredLanguage: 'en'
  });
  return { service, ledger, users, events, outbox, farmer, farmerTwo, supplier, programmes, vouchers, redemptions, funding };
}

type Ctx = Awaited<ReturnType<typeof makeService>>;

/**
 * Activated programme helper. Since stage 23 (audit C3) issuance reserves
 * against the FUNDED float, the default helper funds the full budget
 * envelope; pass `fundKobo` (0 = unfunded) to test the backing invariant.
 */
async function activeProgramme(
  ctx: Ctx,
  overrides: {
    perFarmerCapKobo?: number;
    budgetKobo?: number;
    eligibleStates?: string[];
    eligibleCrops?: string[];
    fundKobo?: number;
  } = {}
) {
  const budgetKobo = overrides.budgetKobo ?? 2_000_000;
  const programme = await ctx.service.createProgramme(
    {
      name: '2026 wet-season fertiliser',
      sponsor: 'FMARD / state programme (STUB demo)',
      perFarmerCapKobo: overrides.perFarmerCapKobo ?? 500_000,
      budgetKobo,
      eligibleStates: overrides.eligibleStates,
      eligibleCrops: overrides.eligibleCrops
    },
    ADMIN.id
  );
  const activated = await ctx.service.activateProgramme(programme.id, ADMIN.id);
  const fundKobo = overrides.fundKobo ?? budgetKobo;
  if (fundKobo > 0) {
    await ctx.service.fundProgramme(
      programme.id,
      { amountKobo: fundKobo, idempotencyKey: `fund-${programme.id}` },
      ADMIN.id
    );
  }
  return activated;
}

let ninSeed = 10000000000;

async function enrol(ctx: Ctx, farmerId: string, programmeId: string, extras: { state?: string; primaryCrop?: string } = {}) {
  ninSeed += 137; // distinct NIN per enrolment (dedupe is enforced per programme)
  return ctx.service.verifyBeneficiary(
    programmeId,
    {
      farmerId,
      nin: verifiedNin(ninSeed),
      fullName: 'Farmer Femi',
      state: extras.state ?? 'Kano',
      primaryCrop: extras.primaryCrop ?? 'maize'
    },
    ADMIN.id
  );
}

async function allocatedVoucher(ctx: Ctx, programmeId: string, farmerId: string, amountKobo = 200_000, key = 'alloc-1') {
  const voucher = await ctx.service.allocateVoucher(
    programmeId,
    { farmerId, amountKobo, idempotencyKey: key },
    ADMIN.id
  );
  await ctx.service.distributeVoucher(voucher.id, ADMIN.id);
  return voucher;
}

describe('InputVouchersService programmes (wave NINVOUCHER)', () => {
  it('creates a DRAFT programme and provisions its liability account', async () => {
    const ctx = await makeService();
    const programme = await ctx.service.createProgramme(
      { name: 'P', sponsor: 'S', perFarmerCapKobo: 100, budgetKobo: 1_000 },
      ADMIN.id
    );
    expect(programme.status).toBe('DRAFT');
    expect(programme.liabilityAccountCode).toBe(programmeLiabilityAccountCode(programme.id));
    const account = await ctx.ledger.getAccountByCode(programme.liabilityAccountCode);
    expect(account.type).toBe('liability');
  });

  it('rejects missing name/sponsor and non-positive amounts', async () => {
    const ctx = await makeService();
    await expect(
      ctx.service.createProgramme({ name: ' ', sponsor: 'S', perFarmerCapKobo: 1, budgetKobo: 1 }, ADMIN.id)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ctx.service.createProgramme({ name: 'N', sponsor: ' ', perFarmerCapKobo: 1, budgetKobo: 1 }, ADMIN.id)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ctx.service.createProgramme({ name: 'N', sponsor: 'S', perFarmerCapKobo: 0, budgetKobo: 1 }, ADMIN.id)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a per-farmer cap above the budget envelope', async () => {
    const ctx = await makeService();
    await expect(
      ctx.service.createProgramme({ name: 'N', sponsor: 'S', perFarmerCapKobo: 2_000, budgetKobo: 1_000 }, ADMIN.id)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('activation encumbers the whole budget in the ledger (double-entry)', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { budgetKobo: 2_000_000 });
    expect(programme.status).toBe('ACTIVE');
    const liability = await ctx.ledger.balance(programme.liabilityAccountCode);
    expect(liability.creditsKobo - liability.debitsKobo).toBe(2_000_000);
    const expense = await ctx.ledger.balance(PLATFORM_SUBSIDY_BUDGET_ACCOUNT);
    expect(expense.debitsKobo - expense.creditsKobo).toBe(2_000_000);
  });

  it('activation replay is idempotent — the encumbrance posts exactly once', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { budgetKobo: 2_000_000 });
    const replay = await ctx.service.activateProgramme(programme.id, ADMIN.id);
    expect(replay.status).toBe('ACTIVE');
    const liability = await ctx.ledger.balance(programme.liabilityAccountCode);
    expect(liability.creditsKobo).toBe(2_000_000);
  });

  it('close blocks further status changes but replays idempotently', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    const closed = await ctx.service.closeProgramme(programme.id, ADMIN.id);
    expect(closed.status).toBe('CLOSED');
    const replay = await ctx.service.closeProgramme(programme.id, ADMIN.id);
    expect(replay.status).toBe('CLOSED');
    await expect(ctx.service.activateProgramme(programme.id, ADMIN.id)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('getProgramme 404s for unknown ids', async () => {
    const ctx = await makeService();
    await expect(ctx.service.getProgramme('prog-nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('InputVouchersService beneficiaries (wave NINVOUCHER)', () => {
  it('enrols a verified farmer — hash + mask + basis stored, never the plaintext NIN', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    const nin = verifiedNin(30000000000);
    const record = await ctx.service.verifyBeneficiary(
      programme.id,
      { farmerId: ctx.farmer.id, nin, fullName: 'Farmer Femi', state: 'Kano', primaryCrop: 'maize' },
      ADMIN.id
    );
    expect(record.verificationBasis).toBe('stub');
    expect(record.ninMask).toBe(`********${nin.slice(-3)}`);
    expect(record.ninHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain(nin);
  });

  it('rejects enrolment when the NIN does not verify (and persists nothing)', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await expect(
      ctx.service.verifyBeneficiary(
        programme.id,
        { farmerId: ctx.farmer.id, nin: rejectedNin(40000000000), fullName: 'Farmer Femi' },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await ctx.service.listBeneficiaries(programme.id)).toHaveLength(0);
  });

  it('rejects a malformed NIN', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await expect(
      ctx.service.verifyBeneficiary(
        programme.id,
        { farmerId: ctx.farmer.id, nin: '123', fullName: 'Farmer Femi' },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enrolment replay is idempotent per (programme, farmer)', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    const first = await enrol(ctx, ctx.farmer.id, programme.id);
    const replay = await enrol(ctx, ctx.farmer.id, programme.id);
    expect(replay.id).toBe(first.id);
    expect(await ctx.service.listBeneficiaries(programme.id)).toHaveLength(1);
  });

  it('blocks a second farmer enrolling with the same NIN in one programme', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    const nin = verifiedNin(50000000000);
    await ctx.service.verifyBeneficiary(
      programme.id,
      { farmerId: ctx.farmer.id, nin, fullName: 'Farmer Femi' },
      ADMIN.id
    );
    await expect(
      ctx.service.verifyBeneficiary(
        programme.id,
        { farmerId: ctx.farmerTwo.id, nin, fullName: 'Farmer Funke' },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('InputVouchersService voucher lifecycle (wave NINVOUCHER)', () => {
  it('allocates an ISSUED voucher to a verified beneficiary', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await ctx.service.allocateVoucher(
      programme.id,
      { farmerId: ctx.farmer.id, amountKobo: 200_000, idempotencyKey: 'a1' },
      ADMIN.id
    );
    expect(voucher.status).toBe('ISSUED');
    expect(voucher.programmeId).toBe(programme.id);
    expect(voucher.distributedAt).toBeUndefined();
  });

  it('allocation replay with the same idempotency key returns the original', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    const first = await ctx.service.allocateVoucher(
      programme.id,
      { farmerId: ctx.farmer.id, amountKobo: 200_000, idempotencyKey: 'a1' },
      ADMIN.id
    );
    const replay = await ctx.service.allocateVoucher(
      programme.id,
      { farmerId: ctx.farmer.id, amountKobo: 200_000, idempotencyKey: 'a1' },
      ADMIN.id
    );
    expect(replay.id).toBe(first.id);
    expect(await ctx.service.listVouchers({ programmeId: programme.id })).toHaveLength(1);
  });

  it('rejects allocation on a non-ACTIVE programme', async () => {
    const ctx = await makeService();
    const programme = await ctx.service.createProgramme(
      { name: 'P', sponsor: 'S', perFarmerCapKobo: 100, budgetKobo: 1_000 },
      ADMIN.id
    );
    await expect(
      ctx.service.allocateVoucher(
        programme.id,
        { farmerId: ctx.farmer.id, amountKobo: 100, idempotencyKey: 'a1' },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects allocation to a farmer who is not a verified beneficiary', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await expect(
      ctx.service.allocateVoucher(
        programme.id,
        { farmerId: ctx.farmer.id, amountKobo: 100, idempotencyKey: 'a1' },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces eligible-state rules', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { eligibleStates: ['Kano'] });
    await enrol(ctx, ctx.farmer.id, programme.id, { state: 'Lagos' });
    await expect(
      ctx.service.allocateVoucher(
        programme.id,
        { farmerId: ctx.farmer.id, amountKobo: 100, idempotencyKey: 'a1' },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    await enrol(ctx, ctx.farmerTwo.id, programme.id, { state: 'kano' });
    const ok = await ctx.service.allocateVoucher(
      programme.id,
      { farmerId: ctx.farmerTwo.id, amountKobo: 100, idempotencyKey: 'a2' },
      ADMIN.id
    );
    expect(ok.status).toBe('ISSUED');
  });

  it('enforces eligible-crop rules', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { eligibleCrops: ['maize'] });
    await enrol(ctx, ctx.farmer.id, programme.id, { primaryCrop: 'cassava' });
    await expect(
      ctx.service.allocateVoucher(
        programme.id,
        { farmerId: ctx.farmer.id, amountKobo: 100, idempotencyKey: 'a1' },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces the per-farmer cap across live obligations', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { perFarmerCapKobo: 300_000 });
    await enrol(ctx, ctx.farmer.id, programme.id);
    await ctx.service.allocateVoucher(
      programme.id,
      { farmerId: ctx.farmer.id, amountKobo: 200_000, idempotencyKey: 'a1' },
      ADMIN.id
    );
    await expect(
      ctx.service.allocateVoucher(
        programme.id,
        { farmerId: ctx.farmer.id, amountKobo: 200_000, idempotencyKey: 'a2' },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces the budget envelope across farmers', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { perFarmerCapKobo: 500_000, budgetKobo: 600_000 });
    await enrol(ctx, ctx.farmer.id, programme.id);
    await enrol(ctx, ctx.farmerTwo.id, programme.id);
    await ctx.service.allocateVoucher(
      programme.id,
      { farmerId: ctx.farmer.id, amountKobo: 500_000, idempotencyKey: 'a1' },
      ADMIN.id
    );
    await expect(
      ctx.service.allocateVoucher(
        programme.id,
        { farmerId: ctx.farmerTwo.id, amountKobo: 500_000, idempotencyKey: 'a2' },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-positive amounts and past expiries', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    await expect(
      ctx.service.allocateVoucher(
        programme.id,
        { farmerId: ctx.farmer.id, amountKobo: 0, idempotencyKey: 'a1' },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ctx.service.allocateVoucher(
        programme.id,
        {
          farmerId: ctx.farmer.id,
          amountKobo: 100,
          idempotencyKey: 'a2',
          expiresAt: '2020-01-01T00:00:00.000Z'
        },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('distribution marks the voucher and replays idempotently', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await ctx.service.allocateVoucher(
      programme.id,
      { farmerId: ctx.farmer.id, amountKobo: 100_000, idempotencyKey: 'a1' },
      ADMIN.id
    );
    const distributed = await ctx.service.distributeVoucher(voucher.id, ADMIN.id);
    expect(distributed.distributedAt).toBeDefined();
    const replay = await ctx.service.distributeVoucher(voucher.id, ADMIN.id);
    expect(replay.distributedAt).toBe(distributed.distributedAt);
  });

  it('redemption settles through the ledger: DR programme liability / CR supplier receivable', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 200_000);
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    const { voucher: redeemed, redemption } = await ctx.service.redeemVoucher(
      voucher.id,
      'INV-1001',
      supplierActor
    );
    expect(redeemed.status).toBe('REDEEMED');
    expect(redemption.supplierId).toBe(ctx.supplier.id);
    expect(redemption.invoiceRef).toBe('INV-1001');
    const liability = await ctx.ledger.balance(programme.liabilityAccountCode);
    expect(liability.creditsKobo - liability.debitsKobo).toBe(programme.budgetKobo - 200_000);
    const receivable = await ctx.ledger.balance(supplierReceivableAccountCode(ctx.supplier.id));
    expect(receivable.creditsKobo - receivable.debitsKobo).toBe(200_000);
  });

  it('a voucher redeems EXACTLY once — replay is a 409', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 200_000);
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    await ctx.service.redeemVoucher(voucher.id, 'INV-1001', supplierActor);
    await expect(ctx.service.redeemVoucher(voucher.id, 'INV-1002', supplierActor)).rejects.toBeInstanceOf(
      ConflictException
    );
    const redemptions = await ctx.service.reconciliation(programme.id);
    expect(redemptions.totals.redeemedKobo).toBe(200_000);
  });

  it('redemption requires distribution and an invoice reference', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await ctx.service.allocateVoucher(
      programme.id,
      { farmerId: ctx.farmer.id, amountKobo: 100_000, idempotencyKey: 'a1' },
      ADMIN.id
    );
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    await expect(ctx.service.redeemVoucher(voucher.id, 'INV-1', supplierActor)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await ctx.service.distributeVoucher(voucher.id, ADMIN.id);
    await expect(ctx.service.redeemVoucher(voucher.id, ' ', supplierActor)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('expired vouchers auto-expire on redemption (410) and release the encumbrance', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await ctx.service.allocateVoucher(
      programme.id,
      {
        farmerId: ctx.farmer.id,
        amountKobo: 100_000,
        idempotencyKey: 'a1',
        expiresAt: new Date(Date.now() + 1_000).toISOString()
      },
      ADMIN.id
    );
    await ctx.service.distributeVoucher(voucher.id, ADMIN.id);
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    // The admin sweep path refuses while the voucher is still valid.
    await expect(ctx.service.expireVoucher(voucher.id, ADMIN.id)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(ctx.service.redeemVoucher(voucher.id, 'INV-1', supplierActor)).rejects.toBeInstanceOf(
      GoneException
    );
    const expired = await ctx.service.getVoucher(voucher.id);
    expect(expired.status).toBe('EXPIRED');
    const liability = await ctx.ledger.balance(programme.liabilityAccountCode);
    expect(liability.creditsKobo - liability.debitsKobo).toBe(programme.budgetKobo - 100_000);
  });

  it('voiding releases the encumbrance and blocks redemption', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 150_000);
    const voided = await ctx.service.voidVoucher(voucher.id, ADMIN.id);
    expect(voided.status).toBe('VOIDED');
    const liability = await ctx.ledger.balance(programme.liabilityAccountCode);
    expect(liability.creditsKobo - liability.debitsKobo).toBe(programme.budgetKobo - 150_000);
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    await expect(ctx.service.redeemVoucher(voucher.id, 'INV-1', supplierActor)).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('only ISSUED vouchers can be voided or distributed', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 150_000);
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    await ctx.service.redeemVoucher(voucher.id, 'INV-1', supplierActor);
    await expect(ctx.service.voidVoucher(voucher.id, ADMIN.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(ctx.service.distributeVoucher(voucher.id, ADMIN.id)).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('farmer statement access is restricted to the owner and reviewers', async () => {
    const ctx = await makeService();
    expect(() =>
      ctx.service.assertFarmerStatementAccess(ctx.farmer.id, { id: ctx.farmerTwo.id, roles: ['farmer'] })
    ).toThrow(ForbiddenException);
    expect(() =>
      ctx.service.assertFarmerStatementAccess(ctx.farmer.id, { id: ctx.farmer.id, roles: ['farmer'] })
    ).not.toThrow();
    expect(() =>
      ctx.service.assertFarmerStatementAccess(ctx.farmer.id, { id: 'reg-1', roles: ['regulator'] })
    ).not.toThrow();
    expect(() =>
      ctx.service.assertFarmerStatementAccess(ctx.farmer.id, { id: 'don-1', roles: ['donor'] })
    ).not.toThrow();
  });
});

describe('InputVouchersService reconciliation + ledger invariants (wave NINVOUCHER)', () => {
  it('the double-entry math ties after a full lifecycle (discrepancy = 0)', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { budgetKobo: 2_000_000, perFarmerCapKobo: 500_000 });
    await enrol(ctx, ctx.farmer.id, programme.id, { state: 'Kano' });
    await enrol(ctx, ctx.farmerTwo.id, programme.id, { state: 'Kaduna' });
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    const v1 = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 200_000, 'a1');
    const v2 = await allocatedVoucher(ctx, programme.id, ctx.farmerTwo.id, 300_000, 'a2');
    await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 100_000, 'a3');
    await ctx.service.redeemVoucher(v1.id, 'INV-1', supplierActor);
    await ctx.service.voidVoucher(v2.id, ADMIN.id);

    const report = await ctx.service.reconciliation(programme.id);
    expect(report.budgetKobo).toBe(2_000_000);
    expect(report.totals.vouchersIssued).toBe(3);
    expect(report.totals.outstandingKobo).toBe(100_000);
    expect(report.totals.redeemedKobo).toBe(200_000);
    expect(report.totals.voidedKobo).toBe(300_000);
    expect(report.totals.beneficiariesVerified).toBe(2);
    // The tie: liability == budget - redeemed - released.
    expect(report.ledger.expectedLiabilityKobo).toBe(2_000_000 - 200_000 - 300_000);
    expect(report.ledger.liabilityKobo).toBe(report.ledger.expectedLiabilityKobo);
    expect(report.ledger.discrepancyKobo).toBe(0);
  });

  it('breaks totals down by beneficiary state', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id, { state: 'Kano' });
    await enrol(ctx, ctx.farmerTwo.id, programme.id, { state: 'Kaduna' });
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    const v1 = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 200_000, 'a1');
    await allocatedVoucher(ctx, programme.id, ctx.farmerTwo.id, 300_000, 'a2');
    await ctx.service.redeemVoucher(v1.id, 'INV-1', supplierActor);
    const report = await ctx.service.reconciliation(programme.id);
    const kano = report.byState.find((row) => row.state === 'Kano');
    const kaduna = report.byState.find((row) => row.state === 'Kaduna');
    expect(kano?.redeemedKobo).toBe(200_000);
    expect(kano?.outstandingKobo).toBe(0);
    expect(kaduna?.outstandingKobo).toBe(300_000);
    expect(kaduna?.redeemedKobo).toBe(0);
  });

  it('double-entry conservation holds across every account after the lifecycle', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { budgetKobo: 2_000_000 });
    await enrol(ctx, ctx.farmer.id, programme.id);
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    const v1 = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 200_000, 'a1');
    const v2 = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 100_000, 'a2');
    await ctx.service.redeemVoucher(v1.id, 'INV-1', supplierActor);
    await ctx.service.voidVoucher(v2.id, ADMIN.id);
    let totalDebits = 0;
    let totalCredits = 0;
    for (const account of await ctx.ledger.listAccounts()) {
      const balance = await ctx.ledger.balance(account.code);
      totalDebits += balance.debitsKobo;
      totalCredits += balance.creditsKobo;
      // Never-negative invariant on debit-positive (asset/expense) accounts.
      if (account.type === 'asset' || account.type === 'expense') {
        expect(balance.balanceKobo, account.code).toBeGreaterThanOrEqual(0);
      }
    }
    expect(totalDebits).toBe(totalCredits);
    expect(totalDebits).toBeGreaterThan(0);
  });

  it('allocation and redemption publish domain events', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    const voucher = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 200_000, 'a1');
    await ctx.service.redeemVoucher(voucher.id, 'INV-1', supplierActor);
    const names = (await ctx.outbox.list()).map((event) => event.name);
    expect(names).toContain('inputvouchers.programme.created');
    expect(names).toContain('inputvouchers.programme.activated');
    expect(names).toContain('inputvouchers.beneficiary.verified');
    expect(names).toContain('inputvouchers.voucher.allocated');
    expect(names).toContain('inputvouchers.voucher.distributed');
    expect(names).toContain('inputvouchers.voucher.redeemed');
  });

  it('identityStatus labels the stub driver honestly', async () => {
    const ctx = await makeService();
    const status = ctx.service.identityStatus();
    expect(status.driver).toBe('stub');
    expect(status.detail.toLowerCase()).toContain('stub');
  });
});

describe('InputVouchersService — stage-22 money-race regressions', () => {
  /** Spy ledger: records attempted posting keys and widens the posting window. */
  function spyLedger(ledger: LedgerService, delayMs: number) {
    const attempts: string[] = [];
    const original = ledger.postEntry.bind(ledger);
    ledger.postEntry = (async (input: Parameters<LedgerService['postEntry']>[0], actorId: string) => {
      attempts.push(input.idempotencyKey);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return original(input, actorId);
    }) as LedgerService['postEntry'];
    return attempts;
  }

  async function ledgerKeys(ctx: Ctx, prefix: string): Promise<string[]> {
    const entries = await ctx.ledger.listEntries({});
    return entries.filter((entry) => entry.idempotencyKey.startsWith(prefix)).map((entry) => entry.idempotencyKey);
  }

  it('concurrent redeem + expire settle exactly one ledger entry — redeem wins the claim (audit C1-6)', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    // Expires in 60ms: redeem loads it as valid, claims REDEEMING, then the
    // delayed posting widens the race window; expiry crosses mid-flight.
    const voucher = await ctx.service.allocateVoucher(
      programme.id,
      {
        farmerId: ctx.farmer.id,
        amountKobo: 100_000,
        idempotencyKey: 'race-1',
        expiresAt: new Date(Date.now() + 60).toISOString()
      },
      ADMIN.id
    );
    await ctx.service.distributeVoucher(voucher.id, ADMIN.id);
    spyLedger(ctx.ledger, 150);
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    const [redeemResult, expireResult] = await Promise.allSettled([
      ctx.service.redeemVoucher(voucher.id, 'INV-RACE', supplierActor),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 80)); // now past expiry
        return ctx.service.expireVoucher(voucher.id, ADMIN.id);
      })()
    ]);
    expect(redeemResult.status).toBe('fulfilled');
    // The expiry sweep loses the claim: REDEEMING is not expirable.
    expect(expireResult.status).toBe('rejected');
    expect((expireResult as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect((await ctx.service.getVoucher(voucher.id)).status).toBe('REDEEMED');
    // Exactly one liability debit — the release posting never happened.
    expect(await ledgerKeys(ctx, `input-voucher-redemption:${voucher.id}`)).toHaveLength(1);
    expect(await ledgerKeys(ctx, `input-voucher-release:${voucher.id}`)).toHaveLength(0);
    const liability = await ctx.ledger.balance(programme.liabilityAccountCode);
    expect(liability.creditsKobo - liability.debitsKobo).toBe(programme.budgetKobo - 100_000);
  });

  it('concurrent expire + redeem settle exactly one ledger entry — expiry wins the claim (audit C1-6)', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await ctx.service.allocateVoucher(
      programme.id,
      {
        farmerId: ctx.farmer.id,
        amountKobo: 100_000,
        idempotencyKey: 'race-2',
        expiresAt: new Date(Date.now() + 30).toISOString()
      },
      ADMIN.id
    );
    await ctx.service.distributeVoucher(voucher.id, ADMIN.id);
    await new Promise((resolve) => setTimeout(resolve, 50)); // past expiry
    spyLedger(ctx.ledger, 150);
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    const [expireResult, redeemResult] = await Promise.allSettled([
      ctx.service.expireVoucher(voucher.id, ADMIN.id),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return ctx.service.redeemVoucher(voucher.id, 'INV-RACE', supplierActor);
      })()
    ]);
    // Expiry claimed EXPIRING first; the redeem attempt converges to 410 (or
    // loses the finalize CAS as a 409) — either way no payout posts.
    expect(['fulfilled', 'rejected']).toContain(expireResult.status);
    expect(redeemResult.status).toBe('rejected');
    expect((await ctx.service.getVoucher(voucher.id)).status).toBe('EXPIRED');
    expect(await ledgerKeys(ctx, `input-voucher-redemption:${voucher.id}`)).toHaveLength(0);
    expect(await ledgerKeys(ctx, `input-voucher-release:${voucher.id}`)).toHaveLength(1);
    const liability = await ctx.ledger.balance(programme.liabilityAccountCode);
    expect(liability.creditsKobo - liability.debitsKobo).toBe(programme.budgetKobo - 100_000);
  });

  it('concurrent redeem + void debit the liability exactly once (audit C1-6)', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 100_000);
    spyLedger(ctx.ledger, 150);
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    const [redeemResult, voidResult] = await Promise.allSettled([
      ctx.service.redeemVoucher(voucher.id, 'INV-RACE', supplierActor),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return ctx.service.voidVoucher(voucher.id, ADMIN.id);
      })()
    ]);
    expect(redeemResult.status).toBe('fulfilled');
    expect(voidResult.status).toBe('rejected');
    expect((voidResult as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect((await ctx.service.getVoucher(voucher.id)).status).toBe('REDEEMED');
    expect(await ledgerKeys(ctx, `input-voucher-redemption:${voucher.id}`)).toHaveLength(1);
    expect(await ledgerKeys(ctx, `input-voucher-release:${voucher.id}`)).toHaveLength(0);
  });

  it('a retry that finds REDEEMING with the redemption row finalizes instead of reposting', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 100_000);
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    // Simulate the crash window: claim held, ledger entry + redemption row
    // landed, but REDEEMING→REDEEMED never finalized.
    await ctx.vouchers.updateExpected(voucher.id, { status: 'REDEEMING' }, { status: 'ISSUED' });
    await ctx.ledger.ensureAccount({
      code: supplierReceivableAccountCode(ctx.supplier.id),
      type: 'liability',
      ownerId: ctx.supplier.id
    });
    const entry = await ctx.ledger.postEntry(
      {
        idempotencyKey: `input-voucher-redemption:${voucher.id}`,
        referenceType: 'input_voucher_redemption',
        referenceId: voucher.id,
        description: 'crashed redemption',
        postings: [
          { accountCode: programme.liabilityAccountCode, direction: 'debit', amountKobo: 100_000 },
          { accountCode: supplierReceivableAccountCode(ctx.supplier.id), direction: 'credit', amountKobo: 100_000 }
        ]
      },
      ctx.supplier.id
    );
    await ctx.redemptions.create({
      id: 'ired-crashed',
      voucherId: voucher.id,
      programmeId: programme.id,
      supplierId: ctx.supplier.id,
      invoiceRef: 'INV-CRASH',
      amountKobo: 100_000,
      idempotencyKey: `input-voucher-redemption:${voucher.id}`,
      ledgerEntryId: entry.id,
      createdAt: new Date().toISOString()
    });
    const settled = await ctx.service.redeemVoucher(voucher.id, 'INV-CRASH', supplierActor);
    expect(settled.voucher.status).toBe('REDEEMED');
    expect(settled.redemption.id).toBe('ired-crashed'); // settled view, not a repost
    expect(await ledgerKeys(ctx, `input-voucher-redemption:${voucher.id}`)).toHaveLength(1);
    expect((await ctx.service.getVoucher(voucher.id)).ledgerEntryId).toBe(entry.id);
  });

  it('a posting failure rolls the REDEEMING claim back to ISSUED so a retry can succeed', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx);
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 100_000);
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    const original = ctx.ledger.postEntry.bind(ctx.ledger);
    ctx.ledger.postEntry = (async () => {
      throw new Error('ledger unavailable');
    }) as LedgerService['postEntry'];
    await expect(ctx.service.redeemVoucher(voucher.id, 'INV-1', supplierActor)).rejects.toThrow(
      'ledger unavailable'
    );
    expect((await ctx.service.getVoucher(voucher.id)).status).toBe('ISSUED'); // claim rolled back
    ctx.ledger.postEntry = original;
    const retried = await ctx.service.redeemVoucher(voucher.id, 'INV-1', supplierActor);
    expect(retried.voucher.status).toBe('REDEEMED');
    expect(await ledgerKeys(ctx, `input-voucher-redemption:${voucher.id}`)).toHaveLength(1);
  });

  it('concurrent 60% + 60% allocations cannot both succeed — the budget lock serialises (audit C2-10)', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { perFarmerCapKobo: 600_000, budgetKobo: 1_000_000 });
    await enrol(ctx, ctx.farmer.id, programme.id);
    await enrol(ctx, ctx.farmerTwo.id, programme.id);
    const [first, second] = await Promise.allSettled([
      ctx.service.allocateVoucher(
        programme.id,
        { farmerId: ctx.farmer.id, amountKobo: 600_000, idempotencyKey: 'cap-race-a' },
        ADMIN.id
      ),
      ctx.service.allocateVoucher(
        programme.id,
        { farmerId: ctx.farmerTwo.id, amountKobo: 600_000, idempotencyKey: 'cap-race-b' },
        ADMIN.id
      )
    ]);
    const settled = [first, second];
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const loser = settled.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(BadRequestException);
    expect(loser.reason.message).toContain('budget');
    expect(await ctx.service.listVouchers({ programmeId: programme.id })).toHaveLength(1);
  });
});

describe('InputVouchersService — stage-23 funded-float backing (audit C3)', () => {
  it('rejects issuance on an UNFUNDED programme with 422 and persists nothing', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { fundKobo: 0 });
    await enrol(ctx, ctx.farmer.id, programme.id);
    await expect(
      ctx.service.allocateVoucher(
        programme.id,
        { farmerId: ctx.farmer.id, amountKobo: 100_000, idempotencyKey: 'b1' },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await ctx.service.listVouchers({ programmeId: programme.id })).toHaveLength(0);
    const funding = await ctx.service.getProgrammeFunding(programme.id);
    expect(funding.fundedKobo).toBe(0);
    expect(funding.reservedKobo).toBe(0);
  });

  it('issues within the float and reserves the face value', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { fundKobo: 500_000 });
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await ctx.service.allocateVoucher(
      programme.id,
      { farmerId: ctx.farmer.id, amountKobo: 200_000, idempotencyKey: 'b1' },
      ADMIN.id
    );
    expect(voucher.status).toBe('ISSUED');
    const funding = await ctx.service.getProgrammeFunding(programme.id);
    expect(funding.fundedKobo).toBe(500_000);
    expect(funding.reservedKobo).toBe(200_000);
    expect(funding.availableKobo).toBe(300_000);
  });

  it('issues exactly at the float limit; the next kobo is rejected', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, {
      perFarmerCapKobo: 500_000,
      budgetKobo: 1_000_000,
      fundKobo: 400_000
    });
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await ctx.service.allocateVoucher(
      programme.id,
      { farmerId: ctx.farmer.id, amountKobo: 400_000, idempotencyKey: 'b1' },
      ADMIN.id
    );
    expect(voucher.status).toBe('ISSUED');
    await expect(
      ctx.service.allocateVoucher(
        programme.id,
        { farmerId: ctx.farmer.id, amountKobo: 100_000, idempotencyKey: 'b2' },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await ctx.service.listVouchers({ programmeId: programme.id })).toHaveLength(1);
    const funding = await ctx.service.getProgrammeFunding(programme.id);
    expect(funding.reservedKobo).toBe(400_000);
    expect(funding.availableKobo).toBe(0);
  });

  it('over-limit issuance persists nothing and leaves the float untouched', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { fundKobo: 300_000 });
    await enrol(ctx, ctx.farmer.id, programme.id);
    await expect(
      ctx.service.allocateVoucher(
        programme.id,
        { farmerId: ctx.farmer.id, amountKobo: 300_001, idempotencyKey: 'b1' },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await ctx.service.listVouchers({ programmeId: programme.id })).toHaveLength(0);
    expect((await ctx.service.getProgrammeFunding(programme.id)).reservedKobo).toBe(0);
  });

  it('concurrent reservations cannot both pass the float — exactly one voucher issues', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, {
      perFarmerCapKobo: 500_000,
      budgetKobo: 1_000_000,
      fundKobo: 500_000
    });
    await enrol(ctx, ctx.farmer.id, programme.id);
    await enrol(ctx, ctx.farmerTwo.id, programme.id);
    const [first, second] = await Promise.allSettled([
      ctx.service.allocateVoucher(
        programme.id,
        { farmerId: ctx.farmer.id, amountKobo: 300_000, idempotencyKey: 'float-race-a' },
        ADMIN.id
      ),
      ctx.service.allocateVoucher(
        programme.id,
        { farmerId: ctx.farmerTwo.id, amountKobo: 300_000, idempotencyKey: 'float-race-b' },
        ADMIN.id
      )
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(UnprocessableEntityException);
    expect(await ctx.service.listVouchers({ programmeId: programme.id })).toHaveLength(1);
    expect((await ctx.service.getProgrammeFunding(programme.id)).reservedKobo).toBe(300_000);
  });

  it('funding top-up replays idempotently — the float credits exactly once', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { fundKobo: 0 });
    const first = await ctx.service.fundProgramme(
      programme.id,
      { amountKobo: 250_000, idempotencyKey: 'top-up-key-1', reference: 'sponsor-tranche-1' },
      ADMIN.id
    );
    expect(first.replayed).toBe(false);
    const replay = await ctx.service.fundProgramme(
      programme.id,
      { amountKobo: 250_000, idempotencyKey: 'top-up-key-1', reference: 'sponsor-tranche-1' },
      ADMIN.id
    );
    expect(replay.replayed).toBe(true);
    expect(replay.event.id).toBe(first.event.id);
    expect(replay.funding.fundedKobo).toBe(250_000); // NOT 500_000
    // A NEW key is a NEW top-up and credits again.
    const second = await ctx.service.fundProgramme(
      programme.id,
      { amountKobo: 100_000, idempotencyKey: 'top-up-key-2' },
      ADMIN.id
    );
    expect(second.replayed).toBe(false);
    expect(second.funding.fundedKobo).toBe(350_000);
  });

  it('funding requires a positive amount and a client idempotency key', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { fundKobo: 0 });
    await expect(
      ctx.service.fundProgramme(programme.id, { amountKobo: 0, idempotencyKey: 'k' }, ADMIN.id)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ctx.service.fundProgramme(programme.id, { amountKobo: 100, idempotencyKey: ' ' }, ADMIN.id)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('redemption moves reserved → settled exactly once (replay cannot double-settle)', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { fundKobo: 500_000 });
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 200_000, 'b1');
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    await ctx.service.redeemVoucher(voucher.id, 'INV-1', supplierActor);
    const funding = await ctx.service.getProgrammeFunding(programme.id);
    expect(funding.reservedKobo).toBe(0);
    expect(funding.settledKobo).toBe(200_000);
    // Settled money CONSUMED the float — it is not issuable again.
    expect(funding.availableKobo).toBe(300_000);
    await expect(ctx.service.redeemVoucher(voucher.id, 'INV-2', supplierActor)).rejects.toBeInstanceOf(
      ConflictException
    );
    const after = await ctx.service.getProgrammeFunding(programme.id);
    expect(after.settledKobo).toBe(200_000);
  });

  it('void and expiry release the reservation so the float backs new issuance', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, {
      perFarmerCapKobo: 500_000,
      budgetKobo: 1_000_000,
      fundKobo: 400_000
    });
    await enrol(ctx, ctx.farmer.id, programme.id);
    const v1 = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 200_000, 'b1');
    const v2 = await ctx.service.allocateVoucher(
      programme.id,
      {
        farmerId: ctx.farmer.id,
        amountKobo: 200_000,
        idempotencyKey: 'b2',
        expiresAt: new Date(Date.now() + 50).toISOString()
      },
      ADMIN.id
    );
    // Float fully reserved — a third voucher cannot issue yet.
    await expect(
      ctx.service.allocateVoucher(
        programme.id,
        { farmerId: ctx.farmer.id, amountKobo: 100_000, idempotencyKey: 'b3' },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await ctx.service.voidVoucher(v1.id, ADMIN.id);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await ctx.service.expireVoucher(v2.id, ADMIN.id);
    const funding = await ctx.service.getProgrammeFunding(programme.id);
    expect(funding.reservedKobo).toBe(0);
    expect(funding.settledKobo).toBe(0);
    expect(funding.availableKobo).toBe(400_000);
    // The released float backs new issuance again.
    const v3 = await ctx.service.allocateVoucher(
      programme.id,
      { farmerId: ctx.farmer.id, amountKobo: 300_000, idempotencyKey: 'b4' },
      ADMIN.id
    );
    expect(v3.status).toBe('ISSUED');
    expect((await ctx.service.getProgrammeFunding(programme.id)).reservedKobo).toBe(300_000);
  });

  it('reconciliation reports the funded-float state alongside the ledger tie', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { budgetKobo: 2_000_000, fundKobo: 500_000 });
    await enrol(ctx, ctx.farmer.id, programme.id);
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    const v1 = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 200_000, 'b1');
    await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 100_000, 'b2');
    await ctx.service.redeemVoucher(v1.id, 'INV-1', supplierActor);
    const report = await ctx.service.reconciliation(programme.id);
    expect(report.funding.fundedKobo).toBe(500_000);
    expect(report.funding.reservedKobo).toBe(100_000);
    expect(report.funding.settledKobo).toBe(200_000);
    expect(report.funding.availableKobo).toBe(200_000);
    expect(report.ledger.discrepancyKobo).toBe(0);
  });

  it('a crash-resume redemption settles the float exactly once (marker-keyed)', async () => {
    const ctx = await makeService();
    const programme = await activeProgramme(ctx, { fundKobo: 500_000 });
    await enrol(ctx, ctx.farmer.id, programme.id);
    const voucher = await allocatedVoucher(ctx, programme.id, ctx.farmer.id, 100_000, 'b1');
    const supplierActor: ActorRef = { id: ctx.supplier.id, roles: ['supplier'] };
    // Simulate the stage-22 crash window: claim held + redemption row landed.
    await ctx.vouchers.updateExpected(voucher.id, { status: 'REDEEMING' }, { status: 'ISSUED' });
    await ctx.ledger.ensureAccount({
      code: supplierReceivableAccountCode(ctx.supplier.id),
      type: 'liability',
      ownerId: ctx.supplier.id
    });
    const entry = await ctx.ledger.postEntry(
      {
        idempotencyKey: `input-voucher-redemption:${voucher.id}`,
        referenceType: 'input_voucher_redemption',
        referenceId: voucher.id,
        description: 'crashed redemption',
        postings: [
          { accountCode: programme.liabilityAccountCode, direction: 'debit', amountKobo: 100_000 },
          { accountCode: supplierReceivableAccountCode(ctx.supplier.id), direction: 'credit', amountKobo: 100_000 }
        ]
      },
      ctx.supplier.id
    );
    await ctx.redemptions.create({
      id: 'ired-crash-f23',
      voucherId: voucher.id,
      programmeId: programme.id,
      supplierId: ctx.supplier.id,
      invoiceRef: 'INV-CRASH',
      amountKobo: 100_000,
      idempotencyKey: `input-voucher-redemption:${voucher.id}`,
      ledgerEntryId: entry.id,
      createdAt: new Date().toISOString()
    });
    const settled = await ctx.service.redeemVoucher(voucher.id, 'INV-CRASH', supplierActor);
    expect(settled.voucher.status).toBe('REDEEMED');
    const funding = await ctx.service.getProgrammeFunding(programme.id);
    expect(funding.reservedKobo).toBe(0);
    expect(funding.settledKobo).toBe(100_000);
  });
});
