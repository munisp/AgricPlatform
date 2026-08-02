import { describe, expect, it } from 'vitest';
import { createInMemoryAnalyticsStarRepository } from './analytics-star.repository.js';

describe('InMemoryAnalyticsStarRepository', () => {
  it('upserts fact orders by natural key (order_id)', async () => {
    const repo = createInMemoryAnalyticsStarRepository();
    const row = {
      orderId: 'order-1',
      listingId: 'listing-1',
      buyerId: 'buyer-1',
      sellerId: 'farmer-1',
      channel: 'web',
      quantity: 1,
      totalKobo: 100,
      status: 'requested',
      statusHistoryCount: 0,
      escrowRequired: false,
      placedAt: '2026-08-01T10:00:00.000Z'
    };
    await repo.upsertFactOrder(row);
    await repo.upsertFactOrder({ ...row, status: 'confirmed', statusHistoryCount: 1 });
    expect((await repo.stats('c')).factOrders).toBe(1);
    expect((await repo.factOrder('order-1'))?.status).toBe('confirmed');
  });

  it('filters fact orders by inclusive placed_at date range and sorts', async () => {
    const repo = createInMemoryAnalyticsStarRepository();
    const base = {
      listingId: 'l',
      buyerId: 'b',
      sellerId: 's',
      channel: 'web',
      quantity: 1,
      totalKobo: 1,
      status: 'requested',
      statusHistoryCount: 0,
      escrowRequired: false
    };
    await repo.upsertFactOrder({ ...base, orderId: 'o-2', placedAt: '2026-08-02T00:00:00.000Z' });
    await repo.upsertFactOrder({ ...base, orderId: 'o-1', placedAt: '2026-08-01T00:00:00.000Z' });
    await repo.upsertFactOrder({ ...base, orderId: 'o-3', placedAt: '2026-08-10T00:00:00.000Z' });
    const ranged = await repo.factOrders({ from: '2026-08-01', to: '2026-08-02' });
    expect(ranged.map((row) => row.orderId)).toEqual(['o-1', 'o-2']);
  });

  it('filters payments and livestock by posted_at / registered_at ranges', async () => {
    const repo = createInMemoryAnalyticsStarRepository();
    await repo.upsertFactPayment({
      entryId: 'e-1',
      idempotencyKey: 'k',
      debitAccounts: [],
      creditAccounts: [],
      amountKobo: 5,
      postedAt: '2026-08-03T00:00:00.000Z'
    });
    await repo.upsertFactLivestock({
      animalId: 'a-1',
      ownerUserId: 'u',
      species: 'goat',
      breed: 'Sahelian',
      state: 'Sokoto',
      status: 'alive',
      registeredAt: '2026-08-04T00:00:00.000Z'
    });
    expect(await repo.factPayments({ from: '2026-08-04' })).toEqual([]);
    expect(await repo.factPayments({ to: '2026-08-03' })).toHaveLength(1);
    expect(await repo.factLivestock({ from: '2026-08-04', to: '2026-08-04' })).toHaveLength(1);
    expect((await repo.factLivestockEntry('a-1'))?.species).toBe('goat');
    expect(await repo.factLivestockEntry('missing')).toBeUndefined();
  });

  it('upserts daily metrics by metric_date', async () => {
    const repo = createInMemoryAnalyticsStarRepository();
    const row = {
      metricDate: '2026-08-01',
      ordersGmvKobo: 1,
      ordersCount: 1,
      activeFarmers: 1,
      escrowHeldKobo: 1,
      livestockRegistered: 0
    };
    await repo.upsertDailyMetric(row);
    await repo.upsertDailyMetric({ ...row, ordersGmvKobo: 99 });
    const metrics = await repo.dailyMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.ordersGmvKobo).toBe(99);
  });

  it('accumulates projection state across runs', async () => {
    const repo = createInMemoryAnalyticsStarRepository();
    await repo.recordProjection('analytics.projector', {
      lastRunAt: '2026-08-01T00:00:00.000Z',
      lastEventId: 'evt-1',
      lastEventAt: '2026-07-31T23:00:00.000Z',
      processedDelta: 2
    });
    await repo.recordProjection('analytics.projector', {
      lastRunAt: '2026-08-02T00:00:00.000Z',
      processedDelta: 3
    });
    const stats = await repo.stats('analytics.projector');
    expect(stats.projection).toMatchObject({
      lastRunAt: '2026-08-02T00:00:00.000Z',
      lastEventId: 'evt-1', // retained when the run had no events
      processedTotal: 5
    });
  });

  it('reports zero counts and no projection for an untouched store', async () => {
    const repo = createInMemoryAnalyticsStarRepository();
    const stats = await repo.stats('analytics.projector');
    expect(stats).toMatchObject({
      dimUsers: 0,
      dimListings: 0,
      factOrders: 0,
      factPayments: 0,
      factLivestock: 0,
      dailyMetrics: 0
    });
    expect(stats.projection).toBeUndefined();
  });
});
