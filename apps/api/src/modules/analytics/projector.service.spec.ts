import { describe, expect, it } from 'vitest';
import type {
  Animal,
  Chapter,
  EscrowRecord,
  LedgerJournalEntry,
  MarketplaceListing,
  Order,
  OrderExtension,
  Profile,
  User
} from '@agric-platform/shared';
import { EventDedupService } from '../../core/event-dedup.service.js';
import type { DomainEvent } from '../../core/domain-events.service.js';
import { createInMemoryAnalyticsStarRepository } from '../../database/repositories/analytics-star.repository.js';
import { InMemoryChapterRepository } from '../../database/repositories/chapter.repository.js';
import { InMemoryOrderExtensionRepository } from '../../database/repositories/commerce-depth.repository.js';
import { InMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import { InMemoryLedgerEntryRepository } from '../../database/repositories/ledger.repository.js';
import { InMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { createInMemoryAnimalRepository } from '../../database/repositories/livestock.repository.js';
import { InMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { InMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryProcessedEventRepository } from '../../database/repositories/processed-event.repository.js';
import { InMemoryProfileRepository } from '../../database/repositories/profile.repository.js';
import { InMemoryUserRepository } from '../../database/repositories/user.repository.js';
import {
  ANALYTICS_PROJECTOR_CONSUMER,
  AnalyticsProjectorService,
  escrowExposureAt
} from './projector.service.js';

/* ------------------------------- fixtures ------------------------------ */

const user: User = {
  id: 'user-farmer-1',
  phone: '+2348000000001',
  fullName: 'Adaeze Obi',
  roles: ['farmer'],
  preferredLanguage: 'en',
  kycTier: 'tier_1',
  isVerified: true,
  createdAt: '2026-07-01T08:00:00.000Z'
};

const buyer: User = {
  id: 'user-buyer-1',
  phone: '+2348000000002',
  fullName: 'Musa Bello',
  roles: ['buyer'],
  preferredLanguage: 'en',
  kycTier: 'tier_0',
  isVerified: false,
  createdAt: '2026-07-02T08:00:00.000Z'
};

const profile: Profile = {
  userId: user.id,
  location: { state: 'Kano', lga: 'Dala' },
  farmingInterests: ['maize'],
  valueChains: [],
  completionScore: 80,
  badges: []
};

const chapter: Chapter = {
  id: 'chapter-kano',
  name: 'Kano Chapter',
  level: 'state',
  state: 'Kano',
  leadUserId: user.id,
  memberCount: 12,
  active: true
};

const listing: MarketplaceListing = {
  id: 'listing-1',
  sellerId: user.id,
  kind: 'produce',
  title: 'Maize 100kg bag',
  crop: 'maize',
  quantity: 50,
  unit: 'bag',
  priceNaira: 45000,
  location: { state: 'Kano', lga: 'Dala' },
  isActive: true
};

const order: Order = {
  id: 'order-1',
  listingId: listing.id,
  buyerId: buyer.id,
  sellerId: user.id,
  quantity: 2,
  totalNaira: 90000,
  status: 'requested',
  escrowRequired: true,
  createdAt: '2026-08-01T10:30:00.000Z'
};

const extension: OrderExtension = {
  id: order.id,
  orderId: order.id,
  variantId: 'variant-1',
  channel: 'agent',
  unitPriceKobo: 4_500_000,
  subtotalKobo: 9_000_000,
  discountKobo: 0,
  totalKobo: 9_000_000,
  createdAt: order.createdAt,
  updatedAt: order.createdAt
};

const ledgerEntry: LedgerJournalEntry = {
  id: 'entry-1',
  idempotencyKey: 'escrow-hold-order-1',
  referenceType: 'marketplace_order',
  referenceId: order.id,
  description: 'Escrow hold',
  postedAt: '2026-08-01T11:00:00.000Z',
  postings: [
    { accountCode: 'platform:cash', direction: 'debit', amountKobo: 9_000_000 },
    { accountCode: `escrow:order:${order.id}`, direction: 'credit', amountKobo: 9_000_000 }
  ]
};

const animal: Animal = {
  id: 'NG-BOV-KD-000001',
  species: 'cattle',
  breed: 'White Fulani',
  sex: 'female',
  ownerUserId: user.id,
  state: 'Kaduna',
  status: 'alive',
  createdAt: '2026-08-02T09:00:00.000Z',
  updatedAt: '2026-08-02T09:00:00.000Z'
};

const heldEscrow: EscrowRecord = {
  id: 'escrow-1',
  orderId: order.id,
  amountKobo: 9_000_000,
  status: 'held',
  heldAt: '2026-08-01T11:00:00.000Z'
};

function event(id: string, name: string, payload: unknown, occurredAt: string): DomainEvent {
  return { id, name, payload, occurredAt };
}

const EVENTS = {
  userRegistered: event('evt-user-1', 'identity.user.registered', { userId: user.id, roles: ['farmer'] }, '2026-07-01T08:00:01.000Z'),
  listingCreated: event('evt-listing-1', 'marketplace.listing.created', { listingId: listing.id }, '2026-07-15T12:00:00.000Z'),
  orderPlaced: event('evt-order-1', 'marketplace.order.placed', { orderId: order.id, listingId: listing.id, totalNaira: 90000, escrowRequired: true }, '2026-08-01T10:30:01.000Z'),
  orderConfirmed: event('evt-order-2', 'marketplace.order.status_changed', { orderId: order.id, from: 'requested', to: 'confirmed' }, '2026-08-01T12:00:00.000Z'),
  orderCompleted: event('evt-order-3', 'marketplace.order.status_changed', { orderId: order.id, from: 'delivered', to: 'completed' }, '2026-08-03T15:00:00.000Z'),
  escrowHeld: event('evt-escrow-1', 'marketplace.escrow.held', { escrowId: heldEscrow.id, orderId: order.id, amountKobo: 9_000_000 }, '2026-08-01T11:00:01.000Z'),
  ledgerPosted: event('evt-ledger-1', 'finance.ledger.entry_posted', { entryId: ledgerEntry.id, idempotencyKey: ledgerEntry.idempotencyKey, referenceId: order.id }, '2026-08-01T11:00:02.000Z'),
  animalRegistered: event('evt-animal-1', 'livestock.animal.registered', { animalId: animal.id, species: 'cattle', ownerUserId: user.id }, '2026-08-02T09:00:01.000Z'),
  unrelated: event('evt-other-1', 'community.topic.created', { topicId: 'topic-1' }, '2026-08-01T00:00:00.000Z')
};

function makeProjector(options: {
  events?: DomainEvent[];
  escrows?: EscrowRecord[];
  withExtensions?: boolean;
}) {
  const outbox = new InMemoryOutboxRepository();
  const star = createInMemoryAnalyticsStarRepository();
  const projector = new AnalyticsProjectorService(
    outbox,
    new EventDedupService(createInMemoryProcessedEventRepository()),
    star,
    new InMemoryOrderRepository([order]) as never,
    new InMemoryListingRepository([listing]) as never,
    new InMemoryOrderExtensionRepository(options.withExtensions === false ? [] : [extension]) as never,
    new InMemoryUserRepository([user, buyer]) as never,
    new InMemoryProfileRepository([profile]) as never,
    new InMemoryChapterRepository([chapter]) as never,
    (() => {
      const entries = new InMemoryLedgerEntryRepository();
      void entries.postEntry(ledgerEntry);
      return entries;
    })() as never,
    createInMemoryAnimalRepository(undefined, [animal]) as never,
    new InMemoryEscrowRepository(options.escrows ?? [heldEscrow]) as never
  );
  return { outbox, star, projector, seed: (events: DomainEvent[]) => events.forEach((e) => void outbox.append(e)) };
}

/* --------------------------------- tests -------------------------------- */

describe('AnalyticsProjectorService.project', () => {
  it('projects a registered member into dim_users with state and chapter', async () => {
    const { star, projector, seed } = makeProjector({});
    seed([EVENTS.userRegistered]);
    await projector.project();
    const stats = await star.stats(ANALYTICS_PROJECTOR_CONSUMER);
    expect(stats.dimUsers).toBe(1);
  });

  it('derives dim user state from the profile and chapter from chapter leadership', async () => {
    const { star, projector, seed } = makeProjector({});
    seed([EVENTS.userRegistered]);
    await projector.project();
    const [dim] = await star.dimUsers();
    expect(dim).toMatchObject({
      userId: user.id,
      roles: ['farmer'],
      state: 'Kano',
      chapterId: chapter.id,
      registeredAt: user.createdAt
    });
  });

  it('refreshes dim user roles on identity.user.roles_updated', async () => {
    const { star, projector, seed } = makeProjector({});
    const rolesUpdated = event('evt-user-2', 'identity.user.roles_updated', { userId: user.id, roles: ['farmer', 'supplier'] }, '2026-07-20T09:00:00.000Z');
    seed([EVENTS.userRegistered, rolesUpdated]);
    await projector.project();
    const [dim] = await star.dimUsers();
    expect(dim?.roles).toEqual(['farmer', 'supplier']);
  });

  it('skips user events for unknown users without failing the run', async () => {
    const { star, projector, seed } = makeProjector({});
    seed([event('evt-ghost-user', 'identity.user.registered', { userId: 'user-ghost', roles: ['farmer'] }, '2026-08-01T00:00:00.000Z')]);
    const result = await projector.project();
    expect(result.applied).toBe(1);
    expect(await star.dimUsers()).toEqual([]);
  });

  it('projects listing dimensions with kind, crop and state', async () => {
    const { star, projector, seed } = makeProjector({});
    seed([EVENTS.listingCreated]);
    await projector.project();
    const [dim] = await star.dimListings();
    expect(dim).toMatchObject({ listingId: listing.id, sellerId: user.id, kind: 'produce', crop: 'maize', state: 'Kano' });
  });

  it('projects listing.created into dim_listings', async () => {
    const { star, projector, seed } = makeProjector({});
    seed([EVENTS.listingCreated]);
    await projector.project();
    expect((await star.stats(ANALYTICS_PROJECTOR_CONSUMER)).dimListings).toBe(1);
  });

  it('projects order.placed into fact_orders with extension channel/variant/kobo', async () => {
    const { star, projector, seed } = makeProjector({});
    seed([EVENTS.orderPlaced]);
    await projector.project();
    const fact = await star.factOrder(order.id);
    expect(fact).toMatchObject({
      orderId: order.id,
      buyerId: buyer.id,
      sellerId: user.id,
      channel: 'agent',
      variantId: 'variant-1',
      totalKobo: 9_000_000,
      status: 'requested',
      statusHistoryCount: 0,
      escrowRequired: true,
      placedAt: order.createdAt
    });
  });

  it('falls back to web channel and naira-derived kobo when no extension row exists', async () => {
    const { star, projector, seed } = makeProjector({ withExtensions: false });
    seed([EVENTS.orderPlaced]);
    await projector.project();
    const fact = await star.factOrder(order.id);
    expect(fact?.channel).toBe('web');
    expect(fact?.totalKobo).toBe(9_000_000); // 90_000 NGN * 100
  });

  it('applies status_changed with an absolute history count and sets fulfilled_at on completion', async () => {
    const { star, projector, seed } = makeProjector({});
    seed([EVENTS.orderPlaced, EVENTS.orderConfirmed, EVENTS.orderCompleted]);
    await projector.project();
    const fact = await star.factOrder(order.id);
    expect(fact?.status).toBe('completed');
    expect(fact?.statusHistoryCount).toBe(2);
    expect(fact?.fulfilledAt).toBe('2026-08-03T15:00:00.000Z');
  });

  it('keeps the first fulfilled_at when completion is followed by more transitions', async () => {
    const { star, projector, seed } = makeProjector({});
    const disputed = event('evt-order-4', 'marketplace.order.status_changed', { orderId: order.id, from: 'completed', to: 'disputed' }, '2026-08-04T09:00:00.000Z');
    seed([EVENTS.orderPlaced, EVENTS.orderConfirmed, EVENTS.orderCompleted, disputed]);
    await projector.project();
    const fact = await star.factOrder(order.id);
    expect(fact?.status).toBe('disputed');
    expect(fact?.statusHistoryCount).toBe(3);
    expect(fact?.fulfilledAt).toBe('2026-08-03T15:00:00.000Z');
  });

  it('rebuilds a missing fact row from the OLTP order when only status_changed arrives', async () => {
    const { star, projector, seed } = makeProjector({});
    seed([EVENTS.orderConfirmed]);
    await projector.project();
    const fact = await star.factOrder(order.id);
    expect(fact).toMatchObject({ orderId: order.id, status: 'confirmed', placedAt: order.createdAt });
  });

  it('leaves a throwing apply unprocessed and retries it on the next run (A4-7)', async () => {
    const { star, projector, seed } = makeProjector({});
    seed([EVENTS.userRegistered, EVENTS.listingCreated]);
    const original = star.upsertDimUser.bind(star);
    let fail = true;
    (star as { upsertDimUser: unknown }).upsertDimUser = async (row: Parameters<typeof original>[0]) => {
      if (fail) throw new Error('mart write unavailable');
      return original(row);
    };

    const first = await projector.project();
    expect(first.failed).toBe(1); // user event apply threw
    expect(first.applied).toBe(1); // one bad event does not abort the run
    expect(await star.dimUsers()).toEqual([]);

    fail = false;
    const second = await projector.project();
    expect(second.failed).toBe(0);
    expect(second.applied).toBe(1); // the failed event is retried, not lost
    expect(second.skipped).toBe(1); // the applied event is dedup-recorded
    expect(await star.dimUsers()).toHaveLength(1);
  });

  it('skips events whose source entity is missing without failing the run', async () => {
    const { projector, seed } = makeProjector({});
    seed([event('evt-ghost', 'marketplace.order.placed', { orderId: 'order-ghost' }, '2026-08-01T00:00:00.000Z')]);
    const result = await projector.project();
    expect(result.applied).toBe(1); // event consumed (dedup recorded), row skipped
  });

  it('projects ledger entries into fact_payments with account arrays and kobo total', async () => {
    const { star, projector, seed } = makeProjector({});
    seed([EVENTS.ledgerPosted]);
    await projector.project();
    const [payment] = await star.factPayments();
    expect(payment).toMatchObject({
      entryId: ledgerEntry.id,
      idempotencyKey: 'escrow-hold-order-1',
      referenceType: 'marketplace_order',
      referenceId: order.id,
      debitAccounts: ['platform:cash'],
      creditAccounts: [`escrow:order:${order.id}`],
      amountKobo: 9_000_000,
      postedAt: ledgerEntry.postedAt
    });
  });

  it('projects animal registrations into fact_livestock', async () => {
    const { star, projector, seed } = makeProjector({});
    seed([EVENTS.animalRegistered]);
    await projector.project();
    const [row] = await star.factLivestock();
    expect(row).toMatchObject({
      animalId: animal.id,
      ownerUserId: user.id,
      species: 'cattle',
      state: 'Kaduna',
      status: 'alive'
    });
  });

  it('updates fact_livestock status on animal.status_changed', async () => {
    const { star, projector, seed } = makeProjector({});
    const sold = event('evt-animal-2', 'livestock.animal.status_changed', { animalId: animal.id, from: 'alive', to: 'sold' }, '2026-08-05T10:00:00.000Z');
    seed([EVENTS.animalRegistered, sold]);
    await projector.project();
    const [row] = await star.factLivestock();
    expect(row?.status).toBe('sold');
  });

  it('ignores events outside the projected set', async () => {
    const { projector, seed } = makeProjector({});
    seed([EVENTS.unrelated]);
    const result = await projector.project();
    expect(result.scanned).toBe(1);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('recomputes mart_daily_metrics for touched Lagos days', async () => {
    const { star, projector, seed } = makeProjector({});
    seed([EVENTS.orderPlaced, EVENTS.escrowHeld, EVENTS.animalRegistered]);
    const result = await projector.project();
    expect(result.recomputedDates).toEqual(['2026-08-01', '2026-08-02']);
    const [day1, day2] = await star.dailyMetrics();
    expect(day1).toMatchObject({
      metricDate: '2026-08-01',
      ordersCount: 1,
      ordersGmvKobo: 9_000_000,
      activeFarmers: 1,
      escrowHeldKobo: 9_000_000,
      livestockRegistered: 0
    });
    expect(day2).toMatchObject({ metricDate: '2026-08-02', ordersCount: 0, livestockRegistered: 1 });
  });

  it('excludes cancelled orders from daily GMV and counts', async () => {
    const { star, projector, seed } = makeProjector({});
    const cancelled = event('evt-order-9', 'marketplace.order.status_changed', { orderId: order.id, from: 'requested', to: 'cancelled' }, '2026-08-01T13:00:00.000Z');
    seed([EVENTS.orderPlaced, cancelled]);
    await projector.project();
    const [day] = await star.dailyMetrics();
    expect(day).toMatchObject({ ordersCount: 0, ordersGmvKobo: 0, activeFarmers: 0 });
  });

  it('records the projection heartbeat for the health probe', async () => {
    const { star, projector, seed } = makeProjector({});
    seed([EVENTS.orderPlaced, EVENTS.animalRegistered]);
    await projector.project();
    const stats = await star.stats(ANALYTICS_PROJECTOR_CONSUMER);
    expect(stats.projection?.processedTotal).toBe(2);
    expect(stats.projection?.lastEventId).toBe('evt-animal-1');
    expect(stats.projection?.lastRunAt).toBeTruthy();
  });

  it('second run is a no-op via the dedup ledger (no double-count)', async () => {
    const { star, projector, seed } = makeProjector({});
    seed([EVENTS.orderPlaced, EVENTS.orderConfirmed, EVENTS.escrowHeld, EVENTS.animalRegistered]);
    const first = await projector.project();
    const second = await projector.project();
    expect(first.applied).toBe(4);
    expect(second.applied).toBe(0);
    expect(second.skipped).toBe(4);
    const fact = await star.factOrder(order.id);
    expect(fact?.statusHistoryCount).toBe(1);
    const stats = await star.stats(ANALYTICS_PROJECTOR_CONSUMER);
    expect(stats.factOrders).toBe(1);
    expect(stats.factLivestock).toBe(1);
  });

  it('incremental run applies only newly appended events', async () => {
    const { outbox, projector, seed } = makeProjector({});
    seed([EVENTS.orderPlaced]);
    await projector.project();
    await outbox.append(EVENTS.orderConfirmed);
    await outbox.append(EVENTS.orderCompleted);
    const result = await projector.project();
    expect(result.applied).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it('full replay into a fresh dedup ledger reproduces identical marts', async () => {
    const events = [
      EVENTS.userRegistered,
      EVENTS.listingCreated,
      EVENTS.orderPlaced,
      EVENTS.orderConfirmed,
      EVENTS.orderCompleted,
      EVENTS.escrowHeld,
      EVENTS.ledgerPosted,
      EVENTS.animalRegistered
    ];
    const first = makeProjector({});
    first.seed(events);
    await first.projector.project();
    const second = makeProjector({});
    second.seed(events);
    await second.projector.project();
    // Replay the same history a second time into a THIRD fresh projector:
    // identical marts (upsert by natural keys).
    const third = makeProjector({});
    third.seed(events);
    await third.projector.project();
    const [a, b] = [await first.star.factOrder(order.id), await third.star.factOrder(order.id)];
    expect(b).toEqual(a);
    expect(await third.star.dailyMetrics()).toEqual(await first.star.dailyMetrics());
    expect(await third.star.factPayments()).toEqual(await first.star.factPayments());
    expect(await third.star.factLivestock()).toEqual(await first.star.factLivestock());
    void second;
  });

  it('replayed status_changed events converge status_history_count (absolute counts)', async () => {
    // Simulate a mart store that survived while processed_events was wiped:
    // apply the stream twice with a fresh dedup ledger on the SAME star repo.
    const { outbox, star, projector, seed } = makeProjector({});
    seed([EVENTS.orderPlaced, EVENTS.orderConfirmed, EVENTS.orderCompleted]);
    await projector.project();
    // Wipe dedup by swapping in a fresh projector over the same repos.
    const freshDedup = new AnalyticsProjectorService(
      outbox,
      new EventDedupService(createInMemoryProcessedEventRepository()),
      star,
      new InMemoryOrderRepository([order]) as never,
      new InMemoryListingRepository([listing]) as never,
      new InMemoryOrderExtensionRepository([extension]) as never,
      new InMemoryUserRepository([user, buyer]) as never,
      new InMemoryProfileRepository([profile]) as never,
      new InMemoryChapterRepository([chapter]) as never,
      (() => {
        const entries = new InMemoryLedgerEntryRepository();
        void entries.postEntry(ledgerEntry);
        return entries;
      })() as never,
      createInMemoryAnimalRepository(undefined, [animal]) as never,
      new InMemoryEscrowRepository([heldEscrow]) as never
    );
    await freshDedup.project();
    const fact = await star.factOrder(order.id);
    expect(fact?.statusHistoryCount).toBe(2); // NOT 4 — counts are absolute
    expect(fact?.status).toBe('completed');
  });
});

describe('escrowExposureAt', () => {
  const eod = new Date('2026-08-01T22:59:59.000Z'); // Lagos end of 2026-08-01

  it('counts escrows held before EOD with no resolution', () => {
    expect(escrowExposureAt([heldEscrow], eod)).toBe(9_000_000);
  });

  it('excludes escrows resolved before EOD', () => {
    const resolved = { ...heldEscrow, status: 'released' as const, resolvedAt: '2026-08-01T20:00:00.000Z' };
    expect(escrowExposureAt([resolved], eod)).toBe(0);
  });

  it('excludes escrows held after EOD', () => {
    const later = { ...heldEscrow, heldAt: '2026-08-02T01:00:00.000Z' };
    expect(escrowExposureAt([later], eod)).toBe(0);
  });

  it('includes escrows resolved after EOD (still open at EOD)', () => {
    const resolvedLater = { ...heldEscrow, status: 'refunded' as const, resolvedAt: '2026-08-03T00:00:00.000Z' };
    expect(escrowExposureAt([resolvedLater], eod)).toBe(9_000_000);
  });
});
