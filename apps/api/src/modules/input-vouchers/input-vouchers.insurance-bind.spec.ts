import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import type { FarmPlot, ParametricProduct } from '@agric-platform/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryFeatureFlagRepository } from '../../database/repositories/feature-flag.repository.js';
import { createInMemoryFarmPlotRepository } from '../../database/repositories/farms.repository.js';
import {
  createInMemoryParametricPolicyRepository,
  createInMemoryParametricProductRepository,
  createInMemoryVoucherCoverRepository,
  createInMemoryVoucherProgrammeRiderRepository
} from '../../database/repositories/insurance.repository.js';
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
  VOUCHER_INSURANCE_RIDER_FLAG,
  programmeInsurancePremiumAccountCode,
  programmeLiabilityAccountCode,
  supplierReceivableAccountCode,
  type ActorRef
} from './input-vouchers.service.js';

const ADMIN: ActorRef = { id: 'user-admin', roles: ['admin'] };
const SUPPLIER: ActorRef = { id: 'user-supplier', roles: ['supplier'] };

const RAIN_PRODUCT: ParametricProduct = {
  id: 'insprod-rain',
  code: 'NG-RAIN-WET-26',
  name: 'Wet-season rainfall deficit cover',
  description: 'test product',
  peril: 'RAINFALL_DEFICIT',
  trigger: {
    metric: 'rainfall_mm',
    operator: 'lte',
    threshold: 40,
    h3Resolution: 7,
    observationWindowDays: 30,
    season: '2026-wet'
  },
  payoutTable: [
    { minRatio: 0.5, payoutPercent: 100 },
    { minRatio: 0, payoutPercent: 25 }
  ],
  premiumRateBps: 800,
  createdAt: '2026-01-01T00:00:00.000Z'
};

/** Premium for the default rider: 100_000 kobo × 800bps × flood-none → 8_000 kobo. */
const RIDER_SUM_INSURED_KOBO = 100_000;
const RIDER_PREMIUM_KOBO = 8_000;
const VOUCHER_FACE_KOBO = 200_000;

function verifiedNin(start: number): string {
  for (let candidate = start; candidate < 99999999999; candidate += 1) {
    const nin = String(candidate).padStart(11, '0');
    if (stubIdentityResult(nin).verified) {
      return nin;
    }
  }
  throw new Error('no verifiable stub NIN found');
}

async function makeService(opts: { flagEnabled?: boolean } = {}) {
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
  const riders = createInMemoryVoucherProgrammeRiderRepository();
  const covers = createInMemoryVoucherCoverRepository();
  const products = createInMemoryParametricProductRepository();
  const policies = createInMemoryParametricPolicyRepository();
  const plots = createInMemoryFarmPlotRepository();
  await products.upsert(RAIN_PRODUCT);
  const flags = new FeatureFlagsService(
    createInMemoryFeatureFlagRepository([
      {
        key: VOUCHER_INSURANCE_RIDER_FLAG,
        enabled: opts.flagEnabled ?? true,
        roleAllowlist: [],
        percentage: 100,
        description: 'test flag'
      }
    ])
  );
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
    {},
    riders,
    covers,
    products,
    policies,
    plots,
    flags
  );
  const farmer = await users.create({
    phone: '+2348000000002',
    fullName: 'Farmer Femi',
    roles: ['farmer'],
    preferredLanguage: 'en'
  });
  const otherFarmer = await users.create({
    phone: '+2348000000009',
    fullName: 'Farmer Funke',
    roles: ['farmer'],
    preferredLanguage: 'en'
  });
  const plot: FarmPlot = {
    id: 'plot-1',
    ownerUserId: farmer.id,
    name: 'Kano plot',
    state: 'Kano',
    lga: 'Kano Municipal',
    centroidLat: 12.0,
    centroidLong: 8.5,
    sizeHectares: 1.5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1
  };
  const otherPlot: FarmPlot = { ...plot, id: 'plot-2', ownerUserId: otherFarmer.id };
  await plots.create(plot);
  await plots.create(otherPlot);
  return {
    service,
    ledger,
    events,
    outbox,
    farmer,
    otherFarmer,
    riders,
    covers,
    policies,
    funding
  };
}

type Ctx = Awaited<ReturnType<typeof makeService>>;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Active, fully funded programme with a rider attached. */
async function programmeWithRider(
  ctx: Ctx,
  rider: { sumInsuredKobo?: number; premiumRateBps?: number; status?: 'active' | 'suspended' } = {}
) {
  const programme = await ctx.service.createProgramme(
    {
      name: '2026 wet-season fertiliser',
      sponsor: 'FMARD (test)',
      perFarmerCapKobo: 500_000,
      budgetKobo: 2_000_000
    },
    ADMIN.id
  );
  await ctx.service.activateProgramme(programme.id, ADMIN.id);
  await ctx.service.fundProgramme(programme.id, { amountKobo: 2_000_000, idempotencyKey: `fund-${programme.id}` }, ADMIN.id);
  const now = new Date().toISOString();
  await ctx.riders.create({
    id: `rider-${programme.id}`,
    programmeId: programme.id,
    productCode: RAIN_PRODUCT.code,
    sumInsuredKobo: rider.sumInsuredKobo ?? RIDER_SUM_INSURED_KOBO,
    premiumRateBps: rider.premiumRateBps ?? RAIN_PRODUCT.premiumRateBps,
    floodBand: 'none',
    status: rider.status ?? 'active',
    createdBy: ADMIN.id,
    createdAt: now,
    updatedAt: now
  });
  return programme;
}

async function distributedVoucher(ctx: Ctx, programmeId: string, farmerId: string) {
  await ctx.service.verifyBeneficiary(
    programmeId,
    { farmerId, nin: verifiedNin(10_000_000_001), fullName: 'Farmer Femi', state: 'Kano', primaryCrop: 'maize' },
    ADMIN.id
  );
  const voucher = await ctx.service.allocateVoucher(
    programmeId,
    { farmerId, amountKobo: VOUCHER_FACE_KOBO, idempotencyKey: `alloc-${programmeId}` },
    ADMIN.id
  );
  await ctx.service.distributeVoucher(voucher.id, ADMIN.id);
  return voucher;
}

describe('Insurance-in-the-Bag: cover binding at voucher redemption (Stage 27)', () => {
  it('binds the cover atomically: envelope split postings, policy active, events after commit', async () => {
    const ctx = await makeService();
    const programme = await programmeWithRider(ctx);
    const voucher = await distributedVoucher(ctx, programme.id, ctx.farmer.id);

    const result = await ctx.service.redeemVoucher(voucher.id, 'INV-001', SUPPLIER, { plotId: 'plot-1' });

    expect(result.voucher.status).toBe('REDEEMED');
    const cover = result.cover;
    expect(cover).toBeDefined();
    expect(cover?.status).toBe('bound');
    expect(cover?.premiumKobo).toBe(RIDER_PREMIUM_KOBO);
    expect(cover?.coverBasis).toBe('stub');
    expect(cover?.plotId).toBe('plot-1');
    expect(cover?.farmerId).toBe(ctx.farmer.id);

    // One atomic ledger entry carries the envelope split: DR programme
    // liability (full face) / CR supplier (face − premium) / CR insurer
    // premium payable (premium).
    const entry = await ctx.ledger.findEntryByIdempotencyKey(`input-voucher-redemption:${voucher.id}`);
    expect(entry?.postings).toEqual([
      { accountCode: programmeLiabilityAccountCode(programme.id), direction: 'debit', amountKobo: VOUCHER_FACE_KOBO },
      {
        accountCode: supplierReceivableAccountCode(SUPPLIER.id),
        direction: 'credit',
        amountKobo: VOUCHER_FACE_KOBO - RIDER_PREMIUM_KOBO
      },
      {
        accountCode: programmeInsurancePremiumAccountCode(programme.id),
        direction: 'credit',
        amountKobo: RIDER_PREMIUM_KOBO
      }
    ]);

    // Funded float settled exactly once for the FULL face value (premium is
    // carved out of the same backed envelope, not backed separately).
    const funding = await ctx.service.getProgrammeFunding(programme.id);
    expect(funding).toMatchObject({ fundedKobo: 2_000_000, reservedKobo: 0, settledKobo: VOUCHER_FACE_KOBO });

    // The bound policy entered 'active' so the existing (gated) trigger /
    // payout lifecycle applies unchanged.
    const policy = await ctx.policies.findById(cover?.policyId ?? '');
    expect(policy).toMatchObject({
      farmerUserId: ctx.farmer.id,
      plotId: 'plot-1',
      productCode: RAIN_PRODUCT.code,
      sumInsuredKobo: RIDER_SUM_INSURED_KOBO,
      premiumKobo: RIDER_PREMIUM_KOBO,
      status: 'active',
      pricingBasis: 'stub'
    });

    // Outbox events: redemption first, then the cover issuance event.
    const names = (await ctx.outbox.list()).map((event) => event.name);
    expect(names).toContain('inputvouchers.voucher.redeemed');
    expect(names).toContain('insurance.voucher_cover.bound');
    expect(names.indexOf('inputvouchers.voucher.redeemed')).toBeLessThan(
      names.indexOf('insurance.voucher_cover.bound')
    );
  });

  it('reconciliation ties the insurer premium payable to bound cover premiums', async () => {
    const ctx = await makeService();
    const programme = await programmeWithRider(ctx);
    const voucher = await distributedVoucher(ctx, programme.id, ctx.farmer.id);
    await ctx.service.redeemVoucher(voucher.id, 'INV-001', SUPPLIER, { plotId: 'plot-1' });

    const report = await ctx.service.reconciliation(programme.id);
    expect(report.ledger.discrepancyKobo).toBe(0);
    expect(report.insurance).toEqual({
      premiumPayableAccountCode: programmeInsurancePremiumAccountCode(programme.id),
      coversBound: 1,
      premiumKobo: RIDER_PREMIUM_KOBO,
      premiumPayableKobo: RIDER_PREMIUM_KOBO,
      discrepancyKobo: 0
    });
  });

  it('replay surfaces 409 and never double-binds the cover or double-credits the premium', async () => {
    const ctx = await makeService();
    const programme = await programmeWithRider(ctx);
    const voucher = await distributedVoucher(ctx, programme.id, ctx.farmer.id);
    await ctx.service.redeemVoucher(voucher.id, 'INV-001', SUPPLIER, { plotId: 'plot-1' });

    await expect(ctx.service.redeemVoucher(voucher.id, 'INV-001', SUPPLIER, { plotId: 'plot-1' })).rejects.toBeInstanceOf(
      ConflictException
    );

    expect(await ctx.covers.all()).toHaveLength(1);
    const premiumBalance = await ctx.ledger.balance(programmeInsurancePremiumAccountCode(programme.id));
    expect(premiumBalance.creditsKobo - premiumBalance.debitsKobo).toBe(RIDER_PREMIUM_KOBO);
    const boundEvents = (await ctx.outbox.list()).filter((event) => event.name === 'insurance.voucher_cover.bound');
    expect(boundEvents).toHaveLength(1);
  });

  it('flag OFF (default): an active rider is not consulted and redemption is unchanged', async () => {
    const ctx = await makeService({ flagEnabled: false });
    const programme = await programmeWithRider(ctx);
    const voucher = await distributedVoucher(ctx, programme.id, ctx.farmer.id);

    // No plotId passed — with the flag off the rider is never consulted.
    const result = await ctx.service.redeemVoucher(voucher.id, 'INV-001', SUPPLIER);

    expect(result.voucher.status).toBe('REDEEMED');
    expect(result.cover).toBeUndefined();
    expect(await ctx.covers.all()).toHaveLength(0);
    const entry = await ctx.ledger.findEntryByIdempotencyKey(`input-voucher-redemption:${voucher.id}`);
    expect(entry?.postings).toHaveLength(2);
    const supplierBalance = await ctx.ledger.balance(supplierReceivableAccountCode(SUPPLIER.id));
    expect(supplierBalance.creditsKobo - supplierBalance.debitsKobo).toBe(VOUCHER_FACE_KOBO);
  });

  it('a suspended rider does not bind', async () => {
    const ctx = await makeService();
    const programme = await programmeWithRider(ctx, { status: 'suspended' });
    const voucher = await distributedVoucher(ctx, programme.id, ctx.farmer.id);
    const result = await ctx.service.redeemVoucher(voucher.id, 'INV-001', SUPPLIER);
    expect(result.cover).toBeUndefined();
    expect(await ctx.covers.all()).toHaveLength(0);
  });

  it('rejects 422 when the bundled premium is not covered by the face value — voucher stays ISSUED', async () => {
    const ctx = await makeService();
    // ₦1,000,000 sum insured at 800bps → ₦80,000 premium > ₦2,000 face value.
    const programme = await programmeWithRider(ctx, { sumInsuredKobo: 100_000_000 });
    const voucher = await distributedVoucher(ctx, programme.id, ctx.farmer.id);

    await expect(
      ctx.service.redeemVoucher(voucher.id, 'INV-001', SUPPLIER, { plotId: 'plot-1' })
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    const current = await ctx.service.getVoucher(voucher.id);
    expect(current.status).toBe('ISSUED');
    expect(await ctx.covers.all()).toHaveLength(0);
    const entry = await ctx.ledger.findEntryByIdempotencyKey(`input-voucher-redemption:${voucher.id}`);
    expect(entry).toBeUndefined();
    // The reservation is untouched (the voucher is still live and backed).
    const funding = await ctx.service.getProgrammeFunding(programme.id);
    expect(funding.reservedKobo).toBe(VOUCHER_FACE_KOBO);
    expect(funding.settledKobo).toBe(0);
  });

  it('rejects 422 PLOT_REQUIRED when the programme has a rider but no plotId is passed', async () => {
    const ctx = await makeService();
    const programme = await programmeWithRider(ctx);
    const voucher = await distributedVoucher(ctx, programme.id, ctx.farmer.id);
    await expect(ctx.service.redeemVoucher(voucher.id, 'INV-001', SUPPLIER)).rejects.toBeInstanceOf(
      UnprocessableEntityException
    );
    expect((await ctx.service.getVoucher(voucher.id)).status).toBe('ISSUED');
  });

  it("rejects 422 when the cover plot does not belong to the voucher farmer", async () => {
    const ctx = await makeService();
    const programme = await programmeWithRider(ctx);
    const voucher = await distributedVoucher(ctx, programme.id, ctx.farmer.id);
    await expect(
      ctx.service.redeemVoucher(voucher.id, 'INV-001', SUPPLIER, { plotId: 'plot-2' })
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect((await ctx.service.getVoucher(voucher.id)).status).toBe('ISSUED');
    expect(await ctx.covers.all()).toHaveLength(0);
  });

  it('production: binding still works (pure accounting) and cover_basis is honestly stamped stub', async () => {
    const ctx = await makeService();
    const programme = await programmeWithRider(ctx);
    const voucher = await distributedVoucher(ctx, programme.id, ctx.farmer.id);
    vi.stubEnv('NODE_ENV', 'production');

    const result = await ctx.service.redeemVoucher(voucher.id, 'INV-001', SUPPLIER, { plotId: 'plot-1' });

    expect(result.voucher.status).toBe('REDEEMED');
    expect(result.cover?.status).toBe('bound');
    expect(result.cover?.coverBasis).toBe('stub');
    expect((await ctx.policies.findById(result.cover?.policyId ?? ''))?.pricingBasis).toBe('stub');
  });
});
