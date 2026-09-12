import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Chapter, EquipmentListing, FarmPlot, H3IndexEntry, Order } from '@agric-platform/shared';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { InMemoryChapterRepository } from '../../database/repositories/chapter.repository.js';
import {
  InMemoryChapterMapSnapshotRepository,
  InMemoryChapterMemberDirectory,
  type ChapterMapSnapshot
} from '../../database/repositories/chapter-map.repository.js';
import { InMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import { InMemoryFarmPlotRepository } from '../../database/repositories/farms.repository.js';
import { InMemoryH3IndexRepository } from '../../database/repositories/geo.repository.js';
import {
  InMemoryInputVoucherRepository,
  InMemoryRedemptionRepository
} from '../../database/repositories/input-vouchers.repository.js';
import { InMemoryEquipmentListingRepository } from '../../database/repositories/mechanization.repository.js';
import { InMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { H3Service } from '../geo/h3.service.js';
import { ChapterMapService } from './chapter-map.service.js';
import { CHAPTER_MAP_SNAPSHOT_TTL_MS, K_ANONYMITY_FLOOR } from './chapter-map.js';

/**
 * Chapter Map service tests over in-memory repositories (Innovation 10,
 * Stage 27): known-answer aggregation over fixture plots/vouchers, the
 * k-anonymity suppression invariant, snapshot upsert idempotency and the
 * stale-badge semantics. Ground-truth cells come from h3.service.spec.ts.
 */

const ZARIA = { lat: 11.0855, long: 7.7199 } as const;
const KANO = { lat: 12.0022, long: 8.592 } as const;
const CELL_A = '87581b966ffffff'; // Zaria res-7
const CELL_A_RES5 = '85581b97fffffff';
const CELL_B = '87580a4edffffff'; // Kano res-7
// NOTE: Kano sits near a pentagon edge, so the res-5 PARENT of CELL_B is
// 85580a4ffffffff — not latLngToCell(KANO, 5) = 85580a47fffffff (verified
// against h3-js; see the h3.service.spec parentAt tests).
const CELL_B_RES5 = '85580a4ffffffff';
const NOW = '2026-09-15T10:00:00.000Z';

const CHAPTER: Chapter = {
  id: 'ch-1',
  name: 'Zaria Ward Cooperative',
  level: 'ward',
  state: 'Kaduna',
  lga: 'Zaria',
  memberCount: 8,
  active: true
};

function h3Entry(entity: string, entityId: string, res7: string, lat: number, long: number): H3IndexEntry {
  return {
    entity,
    entityId,
    h3Res5: res7 === CELL_A ? CELL_A_RES5 : CELL_B_RES5,
    h3Res7: res7,
    h3Res9: res7,
    lat,
    long,
    updatedAt: NOW
  };
}

function plot(
  id: string,
  ownerUserId: string,
  sizeHectares: number,
  at: { lat: number; long: number } = ZARIA
): FarmPlot {
  return {
    id,
    ownerUserId,
    name: `Plot ${id}`,
    state: 'Kaduna',
    lga: 'Zaria',
    centroidLat: at.lat,
    centroidLong: at.long,
    sizeHectares,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1
  };
}

function listing(
  id: string,
  status: EquipmentListing['status'],
  serviceAreaH3: string[],
  serviceAreaResolution: number
): EquipmentListing {
  return {
    id,
    ownerUserId: 'operator-1',
    ownerType: 'cooperative',
    type: 'tractor',
    title: `Listing ${id}`,
    description: '',
    specs: {},
    baseLat: ZARIA.lat,
    baseLong: ZARIA.long,
    serviceAreaH3,
    serviceAreaResolution,
    rates: { perHaNaira: 25_000, perKmNaira: 0, includedKm: 20 },
    availability: [],
    operatorVerification: 'verified',
    status,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function order(id: string, sellerId: string): Order {
  return {
    id,
    listingId: 'ml-1',
    buyerId: 'buyer-1',
    sellerId,
    quantity: 1,
    totalNaira: 5000,
    status: 'confirmed',
    escrowRequired: true,
    createdAt: NOW
  };
}

interface Harness {
  service: ChapterMapService;
  snapshots: InMemoryChapterMapSnapshotRepository;
  outbox: ReturnType<typeof createInMemoryOutboxRepository>;
  events: DomainEventsService;
}

async function makeService(
  snapshotSeed: readonly ChapterMapSnapshot[] = []
): Promise<Harness> {
  const chapters = new InMemoryChapterRepository([CHAPTER]);
  const members = new InMemoryChapterMemberDirectory({
    'ch-1': ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'] // u8: no indexed profile
  });
  const h3Index = new InMemoryH3IndexRepository([
    h3Entry('profile', 'u1', CELL_A, ZARIA.lat, ZARIA.long),
    h3Entry('profile', 'u2', CELL_A, ZARIA.lat, ZARIA.long),
    h3Entry('profile', 'u3', CELL_A, ZARIA.lat, ZARIA.long),
    h3Entry('profile', 'u4', CELL_A, ZARIA.lat, ZARIA.long),
    h3Entry('profile', 'u5', CELL_A, ZARIA.lat, ZARIA.long),
    h3Entry('profile', 'u6', CELL_B, 12.0022, 8.592),
    h3Entry('profile', 'u7', CELL_B, 12.0022, 8.592),
    // p1 is indexed; p2 deliberately is NOT (centroid fallback path).
    h3Entry('farm_plot', 'p1', CELL_A, ZARIA.lat, ZARIA.long)
  ]);
  const plots = new InMemoryFarmPlotRepository([
    plot('p1', 'u1', 1.5),
    plot('p2', 'u2', 2.5),
    plot('p3', 'u6', 3, KANO), // Kano member — suppressed cell
    plot('p4', 'ux-not-a-member', 9) // non-member — ignored
  ]);

  const vouchers = new InMemoryInputVoucherRepository();
  for (const [id, farmerId] of [
    ['v1', 'u1'],
    ['v2', 'u3'],
    ['v3', 'ux-not-a-member'],
    ['v4', 'u7'] // Kano member — lands in the suppressed cell
  ] as const) {
    await vouchers.create({
      id,
      programmeId: 'prog-1',
      beneficiaryId: `ben-${id}`,
      farmerId,
      amountKobo: 100_000,
      status: 'REDEEMED',
      idempotencyKey: `alloc:${id}`,
      expiresAt: '2027-01-01T00:00:00.000Z',
      createdAt: NOW
    });
  }
  const redemptions = new InMemoryRedemptionRepository();
  for (const [id, voucherId] of [
    ['r1', 'v1'],
    ['r2', 'v2'],
    ['r3', 'v3'],
    ['r4', 'v4']
  ] as const) {
    await redemptions.create({
      id,
      voucherId,
      programmeId: 'prog-1',
      supplierId: 'dealer-1',
      invoiceRef: `inv-${id}`,
      amountKobo: 100_000,
      idempotencyKey: `redeem:${id}`,
      ledgerEntryId: `le-${id}`,
      createdAt: NOW
    });
  }

  const equipment = new InMemoryEquipmentListingRepository([
    listing('l1', 'active', [CELL_A], 7),
    listing('l2', 'active', [CELL_B_RES5], 5),
    listing('l3', 'paused', [CELL_A], 7) // paused — never counts
  ]);

  const orders = new InMemoryOrderRepository([order('o1', 'u1'), order('o2', 'u6')]);
  const escrows = new InMemoryEscrowRepository([
    { id: 'e1', orderId: 'o1', amountKobo: 500_000, status: 'held', heldAt: NOW },
    { id: 'e2', orderId: 'o2', amountKobo: 100_000, status: 'held', heldAt: NOW },
    { id: 'e3', orderId: 'o1', amountKobo: 7_000, status: 'released', heldAt: NOW } // not pending
  ]);

  const snapshots = new InMemoryChapterMapSnapshotRepository(snapshotSeed);
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const service = new ChapterMapService(
    chapters,
    members,
    h3Index,
    plots,
    vouchers,
    redemptions,
    equipment,
    escrows,
    orders,
    snapshots,
    new H3Service(),
    new TelemetryService(),
    events
  );
  return { service, snapshots, outbox, events };
}

function cellValue(view: Awaited<ReturnType<ChapterMapService['getMap']>>, h3: string, metric: string) {
  return view.cells.find((cell) => cell.h3 === h3 && cell.metric === metric)?.value;
}

describe('ChapterMapService', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await makeService();
  });

  it('recomputes to the known-answer aggregates and serves only k-anonymous cells', async () => {
    const result = await harness.service.recompute('ch-1', 'admin-1');
    expect(result.cellCount).toBe(2);
    expect(result.rowCount).toBe(12); // 6 metrics x 2 occupied cells (cache keeps raw aggregates)
    expect(result.suppressedCellCount).toBe(1); // CELL_B: 2 members < floor 5
    expect(result.kAnonymityFloor).toBe(K_ANONYMITY_FLOOR);

    const view = await harness.service.getMap('ch-1');
    // The suppressed cell is ABSENT from the API view — for every metric.
    expect(view.cells.every((cell) => cell.h3 === CELL_A)).toBe(true);
    expect(view.suppressedCellCount).toBe(1);
    expect(view.stale).toBe(false);
    expect(view.computedAt).toBe(result.computedAt);

    expect(cellValue(view, CELL_A, 'member_count')).toBe(5); // u8 unindexed — honestly skipped
    expect(cellValue(view, CELL_A, 'plot_count')).toBe(2);
    expect(cellValue(view, CELL_A, 'plot_area_hectares')).toBe(4);
    expect(cellValue(view, CELL_A, 'voucher_redemptions')).toBe(2);
    expect(cellValue(view, CELL_A, 'mechanization_coverage')).toBe(1);
    expect(cellValue(view, CELL_A, 'pending_escrow_kobo')).toBe(500_000);
  });

  it('narrows to a single metric while keeping the suppression invariant', async () => {
    await harness.service.recompute('ch-1');
    const view = await harness.service.getMap('ch-1', 'member_count');
    expect(view.metric).toBe('member_count');
    expect(view.cells).toEqual([{ h3: CELL_A, metric: 'member_count', value: 5 }]);
    expect(view.suppressedCellCount).toBe(1);
  });

  it('recompute is idempotent: PK upsert rewrites, never duplicates', async () => {
    const first = await harness.service.recompute('ch-1');
    const second = await harness.service.recompute('ch-1');
    const stored = await harness.snapshots.findByChapter('ch-1');
    expect(stored).toHaveLength(12); // same 12 PK rows after both runs
    expect(second.rowCount).toBe(first.rowCount);
    const memberRows = stored.filter(
      (row) => row.h3Res7 === CELL_A && row.metric === 'member_count'
    );
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0].valueNumeric).toBe(5);
  });

  it('publishes geo_intel.chapter_map.computed through the outbox', async () => {
    await harness.service.recompute('ch-1', 'admin-1');
    const published = (await harness.outbox.list()).map((event) => event.name);
    expect(published).toContain('geo_intel.chapter_map.computed');
  });

  it('serves stale snapshots with stale=true and the real computedAt (never as live)', async () => {
    const oldComputedAt = new Date(Date.now() - CHAPTER_MAP_SNAPSHOT_TTL_MS - 60_000).toISOString();
    const seeded = await makeService([
      {
        chapterId: 'ch-1',
        h3Res7: CELL_A,
        metric: 'member_count',
        valueNumeric: 5,
        computedAt: oldComputedAt
      }
    ]);
    const view = await seeded.service.getMap('ch-1');
    expect(view.stale).toBe(true);
    expect(view.computedAt).toBe(oldComputedAt);
    expect(cellValue(view, CELL_A, 'member_count')).toBe(5);
    expect(view.ttlMs).toBe(CHAPTER_MAP_SNAPSHOT_TTL_MS);
  });

  it('never-computed chapters answer empty + stale, not a fabricated map', async () => {
    const view = await harness.service.getMap('ch-1');
    expect(view.cells).toEqual([]);
    expect(view.computedAt).toBeNull();
    expect(view.stale).toBe(true);
  });

  it('404s unknown chapters on both read and recompute', async () => {
    await expect(harness.service.getMap('ch-missing')).rejects.toThrowError(NotFoundException);
    await expect(harness.service.recompute('ch-missing')).rejects.toThrowError(NotFoundException);
  });
});
