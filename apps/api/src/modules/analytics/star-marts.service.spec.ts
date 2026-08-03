import { describe, expect, it } from 'vitest';
import type { EscrowRecord } from '@agric-platform/shared';
import { createInMemoryAnalyticsStarRepository } from '../../database/repositories/analytics-star.repository.js';
import { InMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import { ANALYTICS_PROJECTOR_CONSUMER } from './projector.service.js';
import {
  AnalyticsStarService,
  FACT_ORDERS_CSV_HEADER,
  FACT_PAYMENTS_CSV_HEADER,
  factOrdersCsv,
  factPaymentsCsv
} from './star-marts.service.js';
import type { FactOrderRow, FactPaymentRow } from './star-marts.js';

const orderRow: FactOrderRow = {
  orderId: 'order-1',
  listingId: 'listing-1',
  buyerId: 'buyer-1',
  sellerId: 'farmer-1',
  channel: 'web',
  quantity: 2,
  totalKobo: 9_000_000,
  status: 'completed',
  statusHistoryCount: 3,
  escrowRequired: true,
  placedAt: '2026-08-01T10:30:00.000Z',
  fulfilledAt: '2026-08-03T15:00:00.000Z'
};

const cancelledRow: FactOrderRow = {
  ...orderRow,
  orderId: 'order-2',
  status: 'cancelled',
  totalKobo: 1_000_000,
  placedAt: '2026-08-02T08:00:00.000Z'
};

const paymentRow: FactPaymentRow = {
  entryId: 'entry-1',
  idempotencyKey: 'key-1',
  referenceType: 'marketplace_order',
  referenceId: 'order-1',
  debitAccounts: ['platform:cash'],
  creditAccounts: ['escrow:order:order-1'],
  amountKobo: 9_000_000,
  postedAt: '2026-08-01T11:00:00.000Z'
};

const heldEscrow: EscrowRecord = {
  id: 'escrow-1',
  orderId: 'order-1',
  amountKobo: 9_000_000,
  status: 'held',
  heldAt: '2026-08-01T11:00:00.000Z'
};

async function makeService(escrows: EscrowRecord[] = [heldEscrow]) {
  const star = createInMemoryAnalyticsStarRepository();
  await star.upsertFactOrder(orderRow);
  await star.upsertFactOrder(cancelledRow);
  await star.upsertFactPayment(paymentRow);
  await star.upsertFactLivestock({
    animalId: 'NG-BOV-KD-000001',
    ownerUserId: 'farmer-1',
    species: 'cattle',
    breed: 'White Fulani',
    state: 'Kaduna',
    status: 'alive',
    registeredAt: '2026-08-02T09:00:00.000Z'
  });
  await star.upsertDimUser({ userId: 'farmer-1', roles: ['farmer'], registeredAt: '2026-07-01T08:00:00.000Z' });
  await star.upsertDimListing({ listingId: 'listing-1', sellerId: 'farmer-1', kind: 'produce', createdAt: '2026-07-15T12:00:00.000Z' });
  await star.upsertDailyMetric({
    metricDate: '2026-08-01',
    ordersGmvKobo: 9_000_000,
    ordersCount: 1,
    activeFarmers: 1,
    escrowHeldKobo: 9_000_000,
    livestockRegistered: 0
  });
  await star.upsertDailyMetric({
    metricDate: '2026-08-05',
    ordersGmvKobo: 0,
    ordersCount: 0,
    activeFarmers: 0,
    escrowHeldKobo: 0,
    livestockRegistered: 1
  });
  const service = new AnalyticsStarService(star, new InMemoryEscrowRepository(escrows) as never);
  return { star, service };
}

describe('AnalyticsStarService.dailyMetrics', () => {
  it('returns all rows without a range, ordered by date', async () => {
    const { service } = await makeService();
    const rows = await service.dailyMetrics();
    expect(rows.map((row) => row.metricDate)).toEqual(['2026-08-01', '2026-08-05']);
  });

  it('filters by inclusive from/to range', async () => {
    const { service } = await makeService();
    const rows = await service.dailyMetrics({ from: '2026-08-02', to: '2026-08-05' });
    expect(rows.map((row) => row.metricDate)).toEqual(['2026-08-05']);
    const none = await service.dailyMetrics({ from: '2026-09-01', to: '2026-09-30' });
    expect(none).toEqual([]);
  });
});

describe('AnalyticsStarService.summary', () => {
  it('aggregates GMV excluding cancelled orders', async () => {
    const { service } = await makeService();
    const summary = await service.summary();
    expect(summary.gmvKobo).toBe(9_000_000);
    expect(summary.ordersCount).toBe(1);
  });

  it('reports current escrow exposure from open escrow statuses', async () => {
    const { service } = await makeService([
      heldEscrow,
      { ...heldEscrow, id: 'escrow-2', amountKobo: 500_000, status: 'disputed' },
      { ...heldEscrow, id: 'escrow-3', amountKobo: 700_000, status: 'released', resolvedAt: '2026-08-02T00:00:00.000Z' }
    ]);
    const summary = await service.summary();
    expect(summary.escrowHeldKobo).toBe(9_500_000); // held + disputed, not released
  });

  it('reports livestock, member and listing counts and null heartbeat before projection', async () => {
    const { service } = await makeService();
    const summary = await service.summary();
    expect(summary.livestockRegistered).toBe(1);
    expect(summary.members).toBe(1);
    expect(summary.listings).toBe(1);
    expect(summary.lastProjectionAt).toBeNull();
  });

  it('surfaces the projector heartbeat after a recorded run', async () => {
    const { star, service } = await makeService();
    await star.recordProjection(ANALYTICS_PROJECTOR_CONSUMER, {
      lastRunAt: '2026-08-06T00:00:00.000Z',
      processedDelta: 3
    });
    const summary = await service.summary();
    expect(summary.lastProjectionAt).toBe('2026-08-06T00:00:00.000Z');
  });
});

describe('fact CSV exports (lakehouse handoff)', () => {
  it('fact_orders CSV mirrors the star columns 1:1 with an RFC 4180 header', async () => {
    const { service } = await makeService();
    const csv = await service.factCsv('fact_orders');
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(FACT_ORDERS_CSV_HEADER.join(','));
    expect(lines[1]).toBe(
      'order-1,listing-1,buyer-1,farmer-1,web,,2,9000000,completed,3,true,2026-08-01T10:30:00.000Z,2026-08-03T15:00:00.000Z'
    );
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('fact_orders CSV honours the date range on placed_at', async () => {
    const { service } = await makeService();
    const csv = await service.factCsv('fact_orders', { from: '2026-08-02', to: '2026-08-02' });
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('order-2');
  });

  it('fact_payments CSV joins account arrays with semicolons', async () => {
    const { service } = await makeService();
    const csv = await service.factCsv('fact_payments');
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(FACT_PAYMENTS_CSV_HEADER.join(','));
    expect(lines[1]).toBe(
      'entry-1,key-1,marketplace_order,order-1,platform:cash,escrow:order:order-1,9000000,2026-08-01T11:00:00.000Z'
    );
  });

  it('CSV escaping quotes fields containing commas', () => {
    const csv = factOrdersCsv([{ ...orderRow, sellerId: 'farmer, with comma' }]);
    expect(csv.split('\r\n')[1]).toContain('"farmer, with comma"');
  });

  it('empty ranges still emit the header row', () => {
    expect(factOrdersCsv([]).trim()).toBe(FACT_ORDERS_CSV_HEADER.join(','));
    expect(factPaymentsCsv([]).trim()).toBe(FACT_PAYMENTS_CSV_HEADER.join(','));
  });
});
