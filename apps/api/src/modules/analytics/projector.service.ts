import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EscrowRecord } from '@agric-platform/shared';
import { EventDedupService } from '../../core/event-dedup.service.js';
import type { DomainEvent } from '../../core/domain-events.service.js';
import {
  ANIMAL_REPOSITORY,
  ANALYTICS_STAR_REPOSITORY,
  CHAPTER_REPOSITORY,
  ESCROW_REPOSITORY,
  LEDGER_ENTRY_REPOSITORY,
  LISTING_REPOSITORY,
  ORDER_EXTENSION_REPOSITORY,
  ORDER_REPOSITORY,
  OUTBOX_REPOSITORY,
  PROFILE_REPOSITORY,
  USER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { OutboxRepository } from '../../database/repositories/outbox.repository.js';
import type { AnalyticsStarRepository } from '../../database/repositories/analytics-star.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import type { ListingRepository } from '../../database/repositories/listing.repository.js';
import type { OrderExtensionRepository } from '../../database/repositories/commerce-depth.repository.js';
import type { UserRepository } from '../../database/repositories/user.repository.js';
import type { ProfileRepository } from '../../database/repositories/profile.repository.js';
import type { ChapterRepository } from '../../database/repositories/chapter.repository.js';
import type { LedgerEntryRepository } from '../../database/repositories/ledger.repository.js';
import type { AnimalRepository } from '../../database/repositories/livestock.repository.js';
import type { EscrowRepository } from '../../database/repositories/escrow.repository.js';
import { lagosDateKey, lagosDayRange } from './retention.js';
import type { DailyMetricRow, FactOrderRow } from './star-marts.js';

/**
 * Consumer name in events.processed_events — the projector's cursor. The
 * outbox `published_at` flag CANNOT serve as the cursor: the fan-out marks
 * rows published immediately after in-process delivery, so "unpublished"
 * rows are only the ones whose delivery stalled. The per-consumer dedup
 * ledger subsumes them.
 */
export const ANALYTICS_PROJECTOR_CONSUMER = 'analytics.projector';

/** Domain events the projector projects into the star marts. */
export const PROJECTED_EVENT_NAMES = [
  'identity.user.registered',
  'identity.user.roles_updated',
  'marketplace.listing.created',
  'marketplace.listing.updated',
  'marketplace.order.placed',
  'marketplace.order.status_changed',
  'marketplace.escrow.held',
  'marketplace.escrow.status_changed',
  'finance.ledger.entry_posted',
  'livestock.animal.registered',
  'livestock.animal.status_changed'
] as const;

export interface ProjectionRunResult {
  /** Outbox rows inspected (all, in occurred_at order). */
  scanned: number;
  /** Events applied to the marts in this run. */
  applied: number;
  /** Events skipped as already processed (dedup ledger hits). */
  skipped: number;
  /** Lagos calendar days whose daily rollup was recomputed. */
  recomputedDates: string[];
  ranAt: string;
}

interface ProjectorContext {
  /** eventId → running status_changed count for its order (absolute, so
   *  status_history_count converges to the same value on replay). */
  statusCounts: Map<string, number>;
  affectedDates: Set<string>;
}

/**
 * Outbox→mart projector (Wave B). Reads events.outbox in occurred_at order,
 * applies the analytics-relevant ones to the star-schema marts (analytics
 * schema, migration 019) via natural-key upserts, and recomputes the daily
 * rollup rows for every touched Lagos calendar day.
 *
 * Idempotency is layered, so catch-up is safe:
 *   1. events.processed_events (EventDedupService) skips redelivered events;
 *   2. every write is an upsert keyed by the natural key (order_id,
 *      entry_id, animal_id, user_id, listing_id, metric_date);
 *   3. mart_daily_metrics is RECOMPUTED from the fact tables, never
 *      incremented — replaying the full outbox history yields identical rows.
 *
 * There is deliberately no in-process timer: an external scheduler
 * (cron/systemd/k8s CronJob) invokes POST /api/v1/analytics/project.
 */
@Injectable()
export class AnalyticsProjectorService {
  private readonly logger = new Logger(AnalyticsProjectorService.name);

  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    private readonly dedup: EventDedupService,
    @Inject(ANALYTICS_STAR_REPOSITORY) private readonly star: AnalyticsStarRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(LISTING_REPOSITORY) private readonly listings: ListingRepository,
    @Inject(ORDER_EXTENSION_REPOSITORY) private readonly orderExtensions: OrderExtensionRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(CHAPTER_REPOSITORY) private readonly chapters: ChapterRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly ledgerEntries: LedgerEntryRepository,
    @Inject(ANIMAL_REPOSITORY) private readonly animals: AnimalRepository,
    @Inject(ESCROW_REPOSITORY) private readonly escrows: EscrowRepository
  ) {}

  /** One projection pass. Safe to invoke repeatedly and after downtime. */
  async project(): Promise<ProjectionRunResult> {
    const records = await this.outbox.listRecords();
    const context: ProjectorContext = {
      statusCounts: buildStatusCounts(records.map((record) => record.event)),
      affectedDates: new Set<string>()
    };
    let applied = 0;
    let skipped = 0;
    let lastEvent: DomainEvent | undefined;

    for (const record of records) {
      const event = record.event;
      if (!(PROJECTED_EVENT_NAMES as readonly string[]).includes(event.name)) {
        continue;
      }
      if (!(await this.dedup.once(ANALYTICS_PROJECTOR_CONSUMER, event.id))) {
        skipped += 1;
        lastEvent = event;
        continue;
      }
      await this.apply(event, context);
      applied += 1;
      lastEvent = event;
    }

    const recomputed = await this.recomputeDailyMetrics([...context.affectedDates].sort());
    const recomputedDates = recomputed.map((row) => row.metricDate);
    const ranAt = new Date().toISOString();
    await this.star.recordProjection(ANALYTICS_PROJECTOR_CONSUMER, {
      lastRunAt: ranAt,
      ...(lastEvent ? { lastEventId: lastEvent.id, lastEventAt: lastEvent.occurredAt } : {}),
      processedDelta: applied
    });
    this.logger.log(
      `projection run: scanned=${records.length} applied=${applied} skipped=${skipped} dates=${recomputedDates.length}`
    );
    return { scanned: records.length, applied, skipped, recomputedDates, ranAt };
  }

  /** Applies one event to the marts. Missing source entities are skipped
   *  with a warning (the mart row can be rebuilt by a later related event). */
  private async apply(event: DomainEvent, context: ProjectorContext): Promise<void> {
    switch (event.name) {
      case 'identity.user.registered':
      case 'identity.user.roles_updated':
        await this.projectUser(event);
        break;
      case 'marketplace.listing.created':
      case 'marketplace.listing.updated':
        await this.projectListing(event);
        break;
      case 'marketplace.order.placed':
        await this.projectOrderPlaced(event, context);
        break;
      case 'marketplace.order.status_changed':
        await this.projectOrderStatusChanged(event, context);
        break;
      case 'marketplace.escrow.held':
      case 'marketplace.escrow.status_changed':
        context.affectedDates.add(lagosDateKey(new Date(event.occurredAt)));
        break;
      case 'finance.ledger.entry_posted':
        await this.projectLedgerEntry(event);
        break;
      case 'livestock.animal.registered':
        await this.projectAnimal(event, context);
        break;
      case 'livestock.animal.status_changed':
        await this.projectAnimalStatus(event, context);
        break;
      default:
        break;
    }
  }

  private async projectUser(event: DomainEvent): Promise<void> {
    const payload = event.payload as { userId: string; roles?: string[] };
    const user = await this.users.findById(payload.userId);
    if (!user) {
      this.logger.warn(`user ${payload.userId} for event ${event.id} not found; skipping`);
      return;
    }
    const profile = await this.profiles.findByUserId(user.id);
    const led = (await this.chapters.find({})).filter((chapter) => chapter.leadUserId === user.id);
    await this.star.upsertDimUser({
      userId: user.id,
      roles: payload.roles ?? user.roles,
      ...(profile?.location.state ? { state: profile.location.state } : {}),
      ...(led.length > 0 ? { chapterId: led[0]!.id } : {}),
      registeredAt: user.createdAt ?? event.occurredAt
    });
  }

  private async projectListing(event: DomainEvent): Promise<void> {
    const payload = event.payload as { listingId: string };
    const listing = await this.listings.findById(payload.listingId);
    if (!listing) {
      this.logger.warn(`listing ${payload.listingId} for event ${event.id} not found; skipping`);
      return;
    }
    await this.star.upsertDimListing({
      listingId: listing.id,
      sellerId: listing.sellerId,
      kind: listing.kind,
      ...(listing.crop ? { crop: listing.crop } : {}),
      ...(listing.location?.state ? { state: listing.location.state } : {}),
      createdAt: event.occurredAt
    });
  }

  private async projectOrderPlaced(event: DomainEvent, context: ProjectorContext): Promise<void> {
    const payload = event.payload as { orderId: string };
    const order = await this.orders.findById(payload.orderId);
    if (!order) {
      this.logger.warn(`order ${payload.orderId} for event ${event.id} not found; skipping`);
      return;
    }
    // Keep the listing dimension fresh alongside the fact (cheap upsert).
    const listing = await this.listings.findById(order.listingId);
    if (listing) {
      await this.star.upsertDimListing({
        listingId: listing.id,
        sellerId: listing.sellerId,
        kind: listing.kind,
        ...(listing.crop ? { crop: listing.crop } : {}),
        ...(listing.location?.state ? { state: listing.location.state } : {}),
        createdAt: event.occurredAt
      });
    }
    const extension = await this.orderExtensions.findById(order.id);
    await this.star.upsertFactOrder({
      orderId: order.id,
      listingId: order.listingId,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      channel: extension?.channel ?? 'web',
      ...(extension?.variantId ? { variantId: extension.variantId } : {}),
      quantity: order.quantity,
      // The extension's integer-kobo total is authoritative when present
      // (=== order.totalNaira * 100 per the shared contract); legacy orders
      // without an extension row fall back to the naira total.
      totalKobo: extension?.totalKobo ?? Math.round(order.totalNaira * 100),
      status: order.status,
      statusHistoryCount: context.statusCounts.get(event.id) ?? 0,
      escrowRequired: order.escrowRequired,
      placedAt: order.createdAt ?? event.occurredAt
    });
    context.affectedDates.add(lagosDateKey(new Date(order.createdAt ?? event.occurredAt)));
  }

  private async projectOrderStatusChanged(
    event: DomainEvent,
    context: ProjectorContext
  ): Promise<void> {
    const payload = event.payload as { orderId: string; from: string; to: string };
    const existing = await this.star.factOrder(payload.orderId);
    if (!existing) {
      // The placed event is missing (order predates the outbox or the
      // projection started mid-stream) — rebuild the base row from the OLTP
      // record so the mart still converges.
      const order = await this.orders.findById(payload.orderId);
      if (!order) {
        this.logger.warn(`order ${payload.orderId} for event ${event.id} not found; skipping`);
        return;
      }
      await this.projectOrderPlaced(
        { ...event, name: 'marketplace.order.placed' },
        context
      );
    }
    const current = (await this.star.factOrder(payload.orderId)) as FactOrderRow;
    await this.star.upsertFactOrder({
      ...current,
      status: payload.to,
      statusHistoryCount: context.statusCounts.get(event.id) ?? current.statusHistoryCount + 1,
      ...(payload.to === 'completed' && !current.fulfilledAt
        ? { fulfilledAt: event.occurredAt }
        : {})
    });
  }

  private async projectLedgerEntry(event: DomainEvent): Promise<void> {
    const payload = event.payload as { entryId: string };
    const entry = await this.ledgerEntries.findById(payload.entryId);
    if (!entry) {
      this.logger.warn(`ledger entry ${payload.entryId} for event ${event.id} not found; skipping`);
      return;
    }
    const debitAccounts = entry.postings
      .filter((posting) => posting.direction === 'debit')
      .map((posting) => posting.accountCode);
    const creditAccounts = entry.postings
      .filter((posting) => posting.direction === 'credit')
      .map((posting) => posting.accountCode);
    const amountKobo = entry.postings
      .filter((posting) => posting.direction === 'debit')
      .reduce((total, posting) => total + posting.amountKobo, 0);
    await this.star.upsertFactPayment({
      entryId: entry.id,
      idempotencyKey: entry.idempotencyKey,
      ...(entry.referenceType ? { referenceType: entry.referenceType } : {}),
      ...(entry.referenceId ? { referenceId: entry.referenceId } : {}),
      debitAccounts,
      creditAccounts,
      amountKobo,
      postedAt: entry.postedAt ?? event.occurredAt
    });
  }

  private async projectAnimal(event: DomainEvent, context: ProjectorContext): Promise<void> {
    const payload = event.payload as { animalId: string };
    const animal = await this.animals.findById(payload.animalId);
    if (!animal) {
      this.logger.warn(`animal ${payload.animalId} for event ${event.id} not found; skipping`);
      return;
    }
    await this.star.upsertFactLivestock({
      animalId: animal.id,
      ownerUserId: animal.ownerUserId,
      species: animal.species,
      breed: animal.breed,
      state: animal.state,
      status: animal.status,
      registeredAt: animal.createdAt ?? event.occurredAt
    });
    context.affectedDates.add(lagosDateKey(new Date(animal.createdAt ?? event.occurredAt)));
  }

  private async projectAnimalStatus(event: DomainEvent, context: ProjectorContext): Promise<void> {
    const payload = event.payload as { animalId: string; to?: string };
    const existing = await this.star.factLivestockEntry(payload.animalId);
    if (!existing) {
      // Registration event missing — rebuild from the registry record.
      await this.projectAnimal(event, context);
      return;
    }
    const animal = await this.animals.findById(payload.animalId);
    await this.star.upsertFactLivestock({
      ...existing,
      status: animal?.status ?? payload.to ?? existing.status
    });
  }

  /**
   * Recomputes mart_daily_metrics for the given Lagos calendar days FROM the
   * fact tables + current escrow records (never incremented), so any replay
   * converges to identical rows. Definitions (docs/analytics-lakehouse.md):
   * GMV/orders count placements on the day excluding currently-cancelled
   * orders; active_farmers = distinct sellers on the day; escrow_held_kobo =
   * exposure at end of the Lagos day.
   */
  async recomputeDailyMetrics(dates: string[]): Promise<DailyMetricRow[]> {
    if (dates.length === 0) {
      return [];
    }
    const [orders, livestock, escrows] = await Promise.all([
      this.star.factOrders(),
      this.star.factLivestock(),
      this.escrows.find({})
    ]);
    const recomputed: DailyMetricRow[] = [];
    for (const date of dates) {
      const dayOrders = orders.filter((row) => lagosDateKey(new Date(row.placedAt)) === date);
      const counted = dayOrders.filter((row) => row.status !== 'cancelled');
      const row: DailyMetricRow = {
        metricDate: date,
        ordersGmvKobo: counted.reduce((total, order) => total + order.totalKobo, 0),
        ordersCount: counted.length,
        activeFarmers: new Set(counted.map((order) => order.sellerId)).size,
        escrowHeldKobo: escrowExposureAt(escrows, lagosDayRange(date).end),
        livestockRegistered: livestock.filter(
          (animal) => lagosDateKey(new Date(animal.registeredAt)) === date
        ).length
      };
      await this.star.upsertDailyMetric(row);
      recomputed.push(row);
    }
    return recomputed;
  }
}

/** eventId → 1-based running count of status_changed events per order. */
function buildStatusCounts(events: DomainEvent[]): Map<string, number> {
  const perOrder = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.name !== 'marketplace.order.status_changed') {
      continue;
    }
    const orderId = (event.payload as { orderId: string }).orderId;
    const next = (perOrder.get(orderId) ?? 0) + 1;
    perOrder.set(orderId, next);
    counts.set(event.id, next);
  }
  return counts;
}

/** Escrow amount still held at `endOfDay` (held before EOD, unresolved at EOD). */
export function escrowExposureAt(escrows: readonly EscrowRecord[], endOfDay: Date): number {
  return escrows
    .filter(
      (record) =>
        new Date(record.heldAt) < endOfDay &&
        (!record.resolvedAt || new Date(record.resolvedAt) >= endOfDay)
    )
    .reduce((total, record) => total + record.amountKobo, 0);
}
