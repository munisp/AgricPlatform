import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException
} from '@nestjs/common';
import type { ParametricProduct, User } from '@agric-platform/shared';
import { describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryParametricProductRepository,
  createInMemoryVoucherCoverRepository,
  createInMemoryVoucherProgrammeRiderRepository,
  type VoucherCoverRecord
} from '../../database/repositories/insurance.repository.js';
import { createInMemorySubsidyProgrammeRepository } from '../../database/repositories/input-vouchers.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { VoucherCoversService } from './voucher-covers.service.js';

const ADMIN: User = {
  id: 'user-admin',
  phone: '+2348000000001',
  fullName: 'Admin Ada',
  roles: ['admin'],
  preferredLanguage: 'en',
  kycTier: 'tier_3',
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

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
  payoutTable: [{ minRatio: 0, payoutPercent: 25 }],
  premiumRateBps: 800,
  createdAt: '2026-01-01T00:00:00.000Z'
};

async function makeService() {
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const riders = createInMemoryVoucherProgrammeRiderRepository();
  const covers = createInMemoryVoucherCoverRepository();
  const products = createInMemoryParametricProductRepository();
  const programmes = createInMemorySubsidyProgrammeRepository();
  await products.upsert(RAIN_PRODUCT);
  const now = new Date().toISOString();
  await programmes.create({
    id: 'prog-1',
    name: '2026 wet-season fertiliser',
    sponsor: 'FMARD (test)',
    status: 'ACTIVE',
    perFarmerCapKobo: 500_000,
    budgetKobo: 2_000_000,
    eligibleStates: [],
    eligibleCrops: [],
    liabilityAccountCode: 'programme:prog-1:liability',
    createdBy: ADMIN.id,
    createdAt: now,
    updatedAt: now
  });
  const service = new VoucherCoversService(riders, covers, products, programmes, events);
  service.onModuleInit();
  return { service, events, outbox, riders, covers };
}

function boundCover(overrides: Partial<VoucherCoverRecord> = {}): VoucherCoverRecord {
  const now = new Date().toISOString();
  return {
    id: 'ivcov-1',
    voucherId: 'ivc-1',
    policyId: 'inspol-1',
    programmeId: 'prog-1',
    plotId: 'plot-1',
    farmerId: 'farmer-1',
    premiumKobo: 8_000,
    coverBasis: 'stub',
    status: 'bound',
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

async function flush(): Promise<void> {
  // Projector handlers are fire-and-forget from the event fan-out; let the
  // in-memory async chain (project → CAS → publish) settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('VoucherCoversService riders (Stage 27)', () => {
  it('defines a rider with a deterministic premium preview and publishes the quoted event', async () => {
    const ctx = await makeService();
    const result = await ctx.service.defineRider(
      'prog-1',
      { productCode: 'NG-RAIN-WET-26', sumInsuredKobo: 100_000 },
      ADMIN.id
    );
    expect(result.replayed).toBe(false);
    // 100_000 kobo × 800bps × flood-none modifier → 8_000 kobo.
    expect(result.premiumPreviewKobo).toBe(8_000);
    expect(result.rider.premiumRateBps).toBe(800);
    expect(result.rider.floodBand).toBe('none');
    expect(result.rider.status).toBe('active');
    const quoted = (await ctx.outbox.list()).filter((event) => event.name === 'insurance.voucher_cover.quoted');
    expect(quoted).toHaveLength(1);
    expect(quoted[0].payload).toMatchObject({ programmeId: 'prog-1', productCode: 'NG-RAIN-WET-26', premiumKobo: 8_000 });
  });

  it('replays an identical definition without a duplicate event', async () => {
    const ctx = await makeService();
    await ctx.service.defineRider('prog-1', { productCode: 'NG-RAIN-WET-26', sumInsuredKobo: 100_000 }, ADMIN.id);
    const replay = await ctx.service.defineRider(
      'prog-1',
      { productCode: 'NG-RAIN-WET-26', sumInsuredKobo: 100_000 },
      ADMIN.id
    );
    expect(replay.replayed).toBe(true);
    const quoted = (await ctx.outbox.list()).filter((event) => event.name === 'insurance.voucher_cover.quoted');
    expect(quoted).toHaveLength(1);
  });

  it('rejects re-definition with different terms once a cover is bound (RIDER_LOCKED)', async () => {
    const ctx = await makeService();
    await ctx.service.defineRider('prog-1', { productCode: 'NG-RAIN-WET-26', sumInsuredKobo: 100_000 }, ADMIN.id);
    await ctx.covers.create(boundCover());
    await expect(
      ctx.service.defineRider('prog-1', { productCode: 'NG-RAIN-WET-26', sumInsuredKobo: 200_000 }, ADMIN.id)
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows re-definition with different terms while no covers are bound', async () => {
    const ctx = await makeService();
    await ctx.service.defineRider('prog-1', { productCode: 'NG-RAIN-WET-26', sumInsuredKobo: 100_000 }, ADMIN.id);
    const updated = await ctx.service.defineRider(
      'prog-1',
      { productCode: 'NG-RAIN-WET-26', sumInsuredKobo: 200_000, premiumRateBps: 500, floodBand: 'low' },
      ADMIN.id
    );
    expect(updated.replayed).toBe(false);
    // 200_000 × 500bps × 10_500/10_000 → 10_500 kobo.
    expect(updated.premiumPreviewKobo).toBe(10_500);
  });

  it('validates: unknown programme 404, unknown product 400, rate-card bounds, flood band', async () => {
    const ctx = await makeService();
    await expect(
      ctx.service.defineRider('prog-nope', { productCode: 'NG-RAIN-WET-26', sumInsuredKobo: 100_000 }, ADMIN.id)
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      ctx.service.defineRider('prog-1', { productCode: 'NOPE', sumInsuredKobo: 100_000 }, ADMIN.id)
    ).rejects.toBeInstanceOf(BadRequestException);
    // Below the ₦1k rate-card floor.
    await expect(
      ctx.service.defineRider('prog-1', { productCode: 'NG-RAIN-WET-26', sumInsuredKobo: 50_000 }, ADMIN.id)
    ).rejects.toBeInstanceOf(BadRequestException);
    // Above the ₦1M rate-card ceiling.
    await expect(
      ctx.service.defineRider('prog-1', { productCode: 'NG-RAIN-WET-26', sumInsuredKobo: 100_000_001 }, ADMIN.id)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ctx.service.defineRider(
        'prog-1',
        { productCode: 'NG-RAIN-WET-26', sumInsuredKobo: 100_000, premiumRateBps: 0 },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ctx.service.defineRider(
        'prog-1',
        {
          productCode: 'NG-RAIN-WET-26',
          sumInsuredKobo: 100_000,
          floodBand: 'bogus' as never
        },
        ADMIN.id
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('getRider 404s when no rider is defined', async () => {
    const ctx = await makeService();
    await expect(ctx.service.getRider('prog-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('VoucherCoversService cover reads + lifecycle projector (Stage 27)', () => {
  it('restricts cover reads to the covered farmer or authorised reviewers', async () => {
    const ctx = await makeService();
    const cover = await ctx.covers.create(boundCover());
    const owner: User = { ...ADMIN, id: 'farmer-1', roles: ['farmer'] };
    const otherFarmer: User = { ...ADMIN, id: 'farmer-2', roles: ['farmer'] };
    expect((await ctx.service.getCover(cover.id, owner)).id).toBe(cover.id);
    expect((await ctx.service.getCover(cover.id, ADMIN)).id).toBe(cover.id);
    await expect(ctx.service.getCover(cover.id, otherFarmer)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctx.service.getCover('missing', ADMIN)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('projects insurance.trigger.raised onto the cover and publishes voucher_cover.triggered', async () => {
    const ctx = await makeService();
    const cover = await ctx.covers.create(boundCover());
    await ctx.events.publish(
      'insurance.trigger.raised',
      { policyId: cover.policyId, triggerEventId: 'instrig-1', payoutKobo: 25_000 },
      ADMIN.id
    );
    await flush();
    expect((await ctx.covers.findById(cover.id))?.status).toBe('triggered');
    const projected = (await ctx.outbox.list()).filter(
      (event) => event.name === 'insurance.voucher_cover.triggered'
    );
    expect(projected).toHaveLength(1);
    expect(projected[0].payload).toMatchObject({
      coverId: cover.id,
      voucherId: cover.voucherId,
      policyId: cover.policyId,
      payoutKobo: 25_000
    });
  });

  it('projects insurance.payout.paid onto a triggered cover and publishes voucher_cover.payout_posted', async () => {
    const ctx = await makeService();
    const cover = await ctx.covers.create(boundCover({ status: 'triggered' }));
    await ctx.events.publish(
      'insurance.payout.paid',
      { policyId: cover.policyId, payoutId: 'inspay-1', amountKobo: 25_000 },
      ADMIN.id
    );
    await flush();
    expect((await ctx.covers.findById(cover.id))?.status).toBe('paid');
    const projected = (await ctx.outbox.list()).filter(
      (event) => event.name === 'insurance.voucher_cover.payout_posted'
    );
    expect(projected).toHaveLength(1);
    expect(projected[0].payload).toMatchObject({ coverId: cover.id, payoutId: 'inspay-1', amountKobo: 25_000 });
  });

  it('duplicate trigger events replay as a no-op (exactly-once projection)', async () => {
    const ctx = await makeService();
    const cover = await ctx.covers.create(boundCover());
    const payload = { policyId: cover.policyId, triggerEventId: 'instrig-1', payoutKobo: 25_000 };
    await ctx.events.publish('insurance.trigger.raised', payload, ADMIN.id);
    await flush();
    await ctx.events.publish('insurance.trigger.raised', payload, ADMIN.id);
    await flush();
    expect((await ctx.covers.findById(cover.id))?.status).toBe('triggered');
    const projected = (await ctx.outbox.list()).filter(
      (event) => event.name === 'insurance.voucher_cover.triggered'
    );
    expect(projected).toHaveLength(1);
  });

  it('a payout event on a merely bound cover does not skip the triggered state', async () => {
    const ctx = await makeService();
    const cover = await ctx.covers.create(boundCover());
    await ctx.events.publish(
      'insurance.payout.paid',
      { policyId: cover.policyId, payoutId: 'inspay-1', amountKobo: 25_000 },
      ADMIN.id
    );
    await flush();
    expect((await ctx.covers.findById(cover.id))?.status).toBe('bound');
    const projected = (await ctx.outbox.list()).filter(
      (event) => event.name === 'insurance.voucher_cover.payout_posted'
    );
    expect(projected).toHaveLength(0);
  });
});
