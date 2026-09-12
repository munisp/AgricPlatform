import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { FarmPlot, User } from '@agric-platform/shared';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import type { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAuditRepository } from '../../database/repositories/audit.repository.js';
import { createInMemoryFarmPlotRepository } from '../../database/repositories/farms.repository.js';
import { createInMemoryFeatureFlagRepository } from '../../database/repositories/feature-flag.repository.js';
import {
  createInMemoryParametricPayoutRepository,
  createInMemoryParametricPolicyRepository,
  createInMemoryParametricProductRepository,
  createInMemoryParametricTriggerEventRepository,
  createInMemoryRegenDiscountRateCardRepository,
  createInMemoryRegenDiscountRepository,
  type RegenDiscountRecord
} from '../../database/repositories/insurance.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryCarbonEvidenceRepository,
  createInMemoryCarbonPlotRepository,
  type CarbonEvidenceRecord,
  type VslaCarbonPlotRecord
} from '../../database/repositories/vsla-carbon.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { H3Service } from '../geo/h3.service.js';
import { StubFloodRiskDriver } from '../geo-intel/flood-risk.drivers.js';
import { InsuranceService } from './insurance.service.js';
import {
  applyRegenDiscountKobo,
  computePremiumKobo,
  MAX_REGEN_DISCOUNT_BPS,
  MIN_PREMIUM_KOBO
} from './premium.js';
import { REGEN_DISCOUNT_FLAG, RegenDiscountService } from './regen-discount.service.js';
import { floodBandForRank, floodSeverityRank } from './trigger-engine.js';

const farmer = { id: 'farmer-1', roles: ['farmer'] } as unknown as User;
const otherFarmer = { id: 'farmer-2', roles: ['farmer'] } as unknown as User;
const admin = { id: 'admin-1', roles: ['admin'] } as unknown as User;

const h3 = new H3Service();
const stubFlood = new StubFloodRiskDriver();

const PLOT = {
  id: 'plot-1',
  ownerUserId: farmer.id,
  name: 'Zaria North Plot',
  state: 'Kaduna',
  lga: 'Zaria',
  centroidLat: 11.0855,
  centroidLong: 7.7199,
  sizeHectares: 2.5,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1
} satisfies FarmPlot;

const QUOTE = {
  productCode: 'NG-RAIN-WET-26',
  plotId: PLOT.id,
  season: '2026-wet',
  sumInsuredKobo: 2_000_000
};

interface SpanCall {
  name: string;
  attributes: Record<string, unknown>;
}

function fakeTelemetry(spans: SpanCall[]) {
  return {
    increment: vi.fn(),
    record: vi.fn(),
    withSpan: async <T>(name: string, attributes: Record<string, unknown>, fn: () => Promise<T> | T) => {
      spans.push({ name, attributes });
      return fn();
    }
  } as unknown as TelemetryService;
}

async function makeService(opts: { flagEnabled: boolean }) {
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const plotRepo = createInMemoryFarmPlotRepository([PLOT]);
  const products = createInMemoryParametricProductRepository();
  const policies = createInMemoryParametricPolicyRepository();
  const rateCard = createInMemoryRegenDiscountRateCardRepository();
  const discounts = createInMemoryRegenDiscountRepository();
  const carbonPlots = createInMemoryCarbonPlotRepository();
  const carbonEvidence = createInMemoryCarbonEvidenceRepository();
  const audits = createInMemoryAuditRepository();
  const audit = new AuditService(audits);
  const flags = new FeatureFlagsService(
    createInMemoryFeatureFlagRepository([
      {
        key: REGEN_DISCOUNT_FLAG,
        enabled: opts.flagEnabled,
        roleAllowlist: [],
        percentage: 100,
        description: 'test flag'
      }
    ])
  );
  const spans: SpanCall[] = [];
  const telemetry = fakeTelemetry(spans);
  const regen = new RegenDiscountService(
    rateCard,
    discounts,
    carbonPlots,
    carbonEvidence,
    h3,
    flags,
    events,
    audit,
    telemetry
  );
  const insurance = new InsuranceService(
    products,
    policies,
    createInMemoryParametricTriggerEventRepository(),
    createInMemoryParametricPayoutRepository(),
    plotRepo,
    h3,
    ledger,
    events,
    audit,
    regen,
    telemetry
  );
  await insurance.ensureCatalogSeeded();
  return {
    insurance,
    regen,
    rateCard,
    discounts,
    carbonPlots,
    carbonEvidence,
    audits,
    outbox,
    spans,
    telemetry
  };
}

type Ctx = Awaited<ReturnType<typeof makeService>>;

function carbonPlot(overrides: Partial<VslaCarbonPlotRecord> = {}): VslaCarbonPlotRecord {
  return {
    id: 'cplot-1',
    groupId: 'vsla-1',
    ownerUserId: farmer.id,
    name: 'Regen plot',
    practiceType: 'agroforestry',
    hectaresCenti: 150,
    centroidLat: PLOT.centroidLat,
    centroidLong: PLOT.centroidLong,
    // SAME LAND as the insured plot: the res-9 cell of its centroid.
    h3Res9: h3.cellAt(PLOT.centroidLat, PLOT.centroidLong, 9),
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function evidence(overrides: Partial<CarbonEvidenceRecord> = {}): CarbonEvidenceRecord {
  return {
    id: 'carbonevidence-1',
    plotId: 'cplot-1',
    groupId: 'vsla-1',
    season: '2026-wet',
    submittedBy: farmer.id,
    submitterRole: 'farmer',
    survivalRatePct: 82,
    idempotencyKey: 'ev-1',
    createdAt: '2026-02-01T00:00:00.000Z',
    ...overrides
  };
}

/** Base (undiscounted) premium the deterministic stack computes for QUOTE. */
async function basePremiumKobo(sumInsuredKobo = QUOTE.sumInsuredKobo) {
  const assessment = await stubFlood.assess({ latitude: PLOT.centroidLat, longitude: PLOT.centroidLong });
  const floodBand = floodBandForRank(floodSeverityRank(assessment.severity));
  return computePremiumKobo({ sumInsuredKobo, premiumRateBps: 800, floodBand }).premiumKobo;
}

async function eligibleCtx(discountBps = 1_000): Promise<Ctx> {
  const ctx = await makeService({ flagEnabled: true });
  await ctx.regen.setRateCardDiscount(admin, discountBps);
  await ctx.carbonPlots.create(carbonPlot());
  await ctx.carbonEvidence.create(evidence());
  return ctx;
}

describe('RegenDiscountService rate card (Stage 27)', () => {
  it('appends monotonically increasing versions; current() returns the latest', async () => {
    const ctx = await makeService({ flagEnabled: true });
    expect(await ctx.regen.currentRateCard()).toBeUndefined();
    const first = await ctx.regen.setRateCardDiscount(admin, 1_000);
    const second = await ctx.regen.setRateCardDiscount(admin, 1_500);
    expect(first.record.version).toBe(1);
    expect(second.record.version).toBe(2);
    expect((await ctx.regen.currentRateCard())?.discountBps).toBe(1_500);
    expect(await ctx.regen.listRateCardVersions()).toHaveLength(2);
  });

  it('is bounded: rejects negative, fractional and > MAX bps', async () => {
    const ctx = await makeService({ flagEnabled: true });
    await expect(ctx.regen.setRateCardDiscount(admin, -1)).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctx.regen.setRateCardDiscount(admin, 1.5)).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctx.regen.setRateCardDiscount(admin, MAX_REGEN_DISCOUNT_BPS + 1)).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(await ctx.regen.listRateCardVersions()).toHaveLength(0);
  });

  it('is audit-chained: each version rides the tamper-evident hash chain', async () => {
    const ctx = await makeService({ flagEnabled: true });
    await ctx.regen.setRateCardDiscount(admin, 1_000);
    await ctx.regen.setRateCardDiscount(admin, 1_500);
    const events = await ctx.audits.list();
    const cardEvents = events.filter((event) => event.action === 'insurance.regen_rate_card.versioned');
    expect(cardEvents).toHaveLength(2);
    expect(cardEvents[0].hash).toBeDefined();
    expect(cardEvents[1].prevHash).toBe(cardEvents[0].hash);
    expect(cardEvents[1].metadata).toMatchObject({ version: 2, discountBps: 1_500 });
  });
});

describe('Regen Discount at quote time (Stage 27)', () => {
  it('flag OFF (default): the quote is unchanged — no discount, no rows, no events', async () => {
    const ctx = await makeService({ flagEnabled: false });
    await ctx.regen.setRateCardDiscount(admin, 1_000);
    await ctx.carbonPlots.create(carbonPlot());
    await ctx.carbonEvidence.create(evidence());

    const result = await ctx.insurance.quote(farmer, QUOTE);

    const base = await basePremiumKobo();
    expect(result.quote.premiumKobo).toBe(base);
    expect(result.policy.premiumKobo).toBe(base);
    expect(result.regenDiscount).toBeUndefined();
    expect(await ctx.discounts.all()).toHaveLength(0);
    const names = (await ctx.outbox.list()).map((event) => event.name);
    expect(names).not.toContain('insurance.regen_discount.applied');
    const premiumSpans = ctx.spans.filter((span) => span.name === 'insurance.premium.compute');
    expect(premiumSpans).toHaveLength(1);
    expect(premiumSpans[0].attributes.regen_eligible).toBe(false);
  });

  it('flag ON without a rate card fails closed: no discount is invented', async () => {
    const ctx = await makeService({ flagEnabled: true });
    await ctx.carbonPlots.create(carbonPlot());
    await ctx.carbonEvidence.create(evidence());
    const result = await ctx.insurance.quote(farmer, QUOTE);
    expect(result.quote.premiumKobo).toBe(await basePremiumKobo());
    expect(result.regenDiscount).toBeUndefined();
    expect(await ctx.discounts.all()).toHaveLength(0);
  });

  it('eligible plot: deterministic discounted premium + discount row with evidence FK, estimate basis, event + counter', async () => {
    const ctx = await eligibleCtx(1_000);

    const result = await ctx.insurance.quote(farmer, QUOTE);

    const base = await basePremiumKobo();
    const expected = applyRegenDiscountKobo(base, 1_000);
    expect(expected.regenDiscountKobo).toBeGreaterThan(0);
    expect(result.quote.premiumKobo).toBe(expected.premiumKobo);
    expect(result.policy.premiumKobo).toBe(expected.premiumKobo);

    const discount = result.regenDiscount as RegenDiscountRecord;
    expect(discount.policyId).toBe(result.policy.id);
    expect(discount.plotId).toBe(PLOT.id);
    // Evidence FK: the discount references the real recorded attestation row.
    expect(discount.attestationId).toBe('carbonevidence-1');
    const linked = await ctx.carbonEvidence.find({ plotId: 'cplot-1' });
    expect(linked.map((row) => row.id)).toContain(discount.attestationId);
    // Human/enumerator attestation without live NDVI → estimate-only badge.
    expect(discount.evidenceBasis).toBe('estimate');
    expect(discount.discountBps).toBe(1_000);
    expect(discount.discountKobo).toBe(expected.regenDiscountKobo);
    expect(discount.rateCardVersion).toBe(1);

    const applied = (await ctx.outbox.list()).filter(
      (event) => event.name === 'insurance.regen_discount.applied'
    );
    expect(applied).toHaveLength(1);
    expect(applied[0].payload).toMatchObject({
      policyId: result.policy.id,
      attestationId: 'carbonevidence-1',
      evidenceBasis: 'estimate',
      rateCardVersion: 1
    });
    expect(ctx.telemetry.increment).toHaveBeenCalledWith(
      'insurance.regen_discounts_applied_total',
      1,
      expect.objectContaining({ evidence_basis: 'estimate' })
    );
    const premiumSpans = ctx.spans.filter((span) => span.name === 'insurance.premium.compute');
    expect(premiumSpans[0].attributes.regen_eligible).toBe(true);
  });

  it('a live-NDVI-linked attestation is labelled evidence_basis=live (never upgraded from stub)', async () => {
    const ctx = await makeService({ flagEnabled: true });
    await ctx.regen.setRateCardDiscount(admin, 1_000);
    await ctx.carbonPlots.create(carbonPlot());
    await ctx.carbonEvidence.create(
      evidence({ id: 'carbonevidence-live', idempotencyKey: 'ev-live', ndviHealthScore: 78, ndviBasis: 'live' })
    );
    const result = await ctx.insurance.quote(farmer, QUOTE);
    expect(result.regenDiscount?.evidenceBasis).toBe('live');
    expect(result.regenDiscount?.attestationId).toBe('carbonevidence-live');
  });

  it('stub-NDVI attestation stays estimate-only', async () => {
    const ctx = await makeService({ flagEnabled: true });
    await ctx.regen.setRateCardDiscount(admin, 1_000);
    await ctx.carbonPlots.create(carbonPlot());
    await ctx.carbonEvidence.create(
      evidence({ ndviHealthScore: 55, ndviBasis: 'stub', ndviClassification: 'moderate' })
    );
    const result = await ctx.insurance.quote(farmer, QUOTE);
    expect(result.regenDiscount?.evidenceBasis).toBe('estimate');
  });

  it('stale attestation (different season only): no discount + rejected_stale_evidence event', async () => {
    const ctx = await makeService({ flagEnabled: true });
    await ctx.regen.setRateCardDiscount(admin, 1_000);
    await ctx.carbonPlots.create(carbonPlot());
    await ctx.carbonEvidence.create(evidence({ season: '2025-wet' }));

    const result = await ctx.insurance.quote(farmer, QUOTE);

    expect(result.quote.premiumKobo).toBe(await basePremiumKobo());
    expect(result.regenDiscount).toBeUndefined();
    expect(await ctx.discounts.all()).toHaveLength(0);
    const rejected = (await ctx.outbox.list()).filter(
      (event) => event.name === 'insurance.regen_discount.rejected_stale_evidence'
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].payload).toMatchObject({
      plotId: PLOT.id,
      season: '2026-wet',
      staleSeason: '2025-wet',
      staleAttestationId: 'carbonevidence-1'
    });
  });

  it('attestation on other land or another farmer plot does not qualify (no fabricated eligibility)', async () => {
    const ctx = await makeService({ flagEnabled: true });
    await ctx.regen.setRateCardDiscount(admin, 1_000);
    // Different land: same owner, different res-9 cell.
    await ctx.carbonPlots.create(carbonPlot({ id: 'cplot-far', h3Res9: h3.cellAt(6.5, 3.4, 9) }));
    await ctx.carbonEvidence.create(evidence({ plotId: 'cplot-far' }));
    // Same land, different owner.
    await ctx.carbonPlots.create(carbonPlot({ id: 'cplot-other', ownerUserId: otherFarmer.id }));
    await ctx.carbonEvidence.create(
      evidence({ id: 'carbonevidence-other', plotId: 'cplot-other', idempotencyKey: 'ev-other' })
    );

    const result = await ctx.insurance.quote(farmer, QUOTE);

    expect(result.quote.premiumKobo).toBe(await basePremiumKobo());
    expect(result.regenDiscount).toBeUndefined();
    expect((await ctx.outbox.list()).map((event) => event.name)).not.toContain(
      'insurance.regen_discount.rejected_stale_evidence'
    );
  });

  it('one discount per policy: duplicate rows conflict, resume adopts the existing row', async () => {
    const ctx = await eligibleCtx(1_000);
    const result = await ctx.insurance.quote(farmer, QUOTE);
    const discount = result.regenDiscount as RegenDiscountRecord;

    const adopted = await ctx.regen.recordDiscount({
      policyId: result.policy.id,
      plotId: PLOT.id,
      actorId: farmer.id,
      eligibility: {
        eligible: true,
        discountBps: 1_000,
        rateCardVersion: 1,
        attestationId: 'carbonevidence-1',
        evidenceBasis: 'estimate'
      },
      discountKobo: discount.discountKobo
    });
    expect(adopted.id).toBe(discount.id);
    expect(await ctx.discounts.all()).toHaveLength(1);

    await expect(
      ctx.discounts.create({ ...discount, id: 'insregen-twin' })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await ctx.outbox.list()).filter((event) => event.name === 'insurance.regen_discount.applied')
    ).toHaveLength(1);
  });

  it('floor cap: a 50% discount never drops the premium below the ₦1k floor', async () => {
    const ctx = await eligibleCtx(MAX_REGEN_DISCOUNT_BPS);
    const base = await basePremiumKobo(1_500_000);
    // Base premium 120_000..180_000 kobo across bands; 50% would land below the floor.
    expect(base).toBeGreaterThan(MIN_PREMIUM_KOBO);
    expect(base / 2).toBeLessThanOrEqual(MIN_PREMIUM_KOBO);

    const result = await ctx.insurance.quote(farmer, { ...QUOTE, sumInsuredKobo: 1_500_000 });

    expect(result.policy.premiumKobo).toBe(MIN_PREMIUM_KOBO);
    expect(result.regenDiscount?.discountKobo).toBe(base - MIN_PREMIUM_KOBO);
  });

  it('premium at/below the floor earns no discount row (cap is not a surcharge)', async () => {
    const base = await basePremiumKobo(1_000_000);
    if (base > MIN_PREMIUM_KOBO) {
      // Guard the fixture: with the stub flood band for these coords the
      // ₦10k sum-insured premium must sit at/below the ₦1k floor.
      throw new Error(`fixture premium ${base} unexpectedly above the floor`);
    }
    const ctx = await eligibleCtx(1_000);
    const result = await ctx.insurance.quote(farmer, { ...QUOTE, sumInsuredKobo: 1_000_000 });
    expect(result.policy.premiumKobo).toBe(base);
    expect(result.regenDiscount).toBeUndefined();
    expect(await ctx.discounts.all()).toHaveLength(0);
  });

  it('rate-card edits after quoting do not rewrite the recorded discount (version pinned)', async () => {
    const ctx = await eligibleCtx(1_000);
    const result = await ctx.insurance.quote(farmer, QUOTE);
    await ctx.regen.setRateCardDiscount(admin, 2_000);
    const stored = await ctx.regen.getDiscountForPolicy(result.policy.id);
    expect(stored.discountBps).toBe(1_000);
    expect(stored.rateCardVersion).toBe(1);
    expect((await ctx.regen.currentRateCard())?.discountBps).toBe(2_000);
  });

  it('getDiscountForPolicy 404s for a policy without a discount', async () => {
    const ctx = await makeService({ flagEnabled: true });
    const result = await ctx.insurance.quote(farmer, QUOTE);
    await expect(ctx.regen.getDiscountForPolicy(result.policy.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
