import type pg from 'pg';
import type {
  DailyMetricRow,
  DimListingRow,
  DimUserRow,
  FactLivestockRow,
  FactOrderRow,
  FactPaymentRow
} from '../../modules/analytics/star-marts.js';
import { num, ts } from '../pg/pg-repository.base.js';
import type { MartDateRange } from './analytics-mart.repository.js';
import type {
  AnalyticsStarRepository,
  AnalyticsStarStats,
  ProjectionStateUpdate
} from './analytics-star.repository.js';

/**
 * PostgreSQL star-schema mart repository (Wave B; analytics schema,
 * migration 019). Upserts are keyed by natural keys (PKs) so the outbox→mart
 * projector is idempotent and catch-up safe.
 */
export class PgAnalyticsStarRepository implements AnalyticsStarRepository {
  constructor(private readonly pool: pg.Pool) {}

  async upsertDimUser(row: DimUserRow): Promise<DimUserRow> {
    await this.pool.query(
      `INSERT INTO analytics.dim_users (user_id, roles, state, chapter_id, registered_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         roles = EXCLUDED.roles,
         state = EXCLUDED.state,
         chapter_id = EXCLUDED.chapter_id,
         registered_at = EXCLUDED.registered_at,
         projected_at = now()`,
      [row.userId, row.roles, row.state ?? null, row.chapterId ?? null, row.registeredAt]
    );
    return row;
  }

  async upsertDimListing(row: DimListingRow): Promise<DimListingRow> {
    await this.pool.query(
      `INSERT INTO analytics.dim_listings (listing_id, seller_id, kind, crop, state, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (listing_id) DO UPDATE SET
         seller_id = EXCLUDED.seller_id,
         kind = EXCLUDED.kind,
         crop = EXCLUDED.crop,
         state = EXCLUDED.state,
         created_at = EXCLUDED.created_at,
         projected_at = now()`,
      [row.listingId, row.sellerId, row.kind, row.crop ?? null, row.state ?? null, row.createdAt]
    );
    return row;
  }

  async upsertFactOrder(row: FactOrderRow): Promise<FactOrderRow> {
    await this.pool.query(
      `INSERT INTO analytics.fact_orders
         (order_id, listing_id, buyer_id, seller_id, channel, variant_id, quantity,
          total_kobo, status, status_history_count, escrow_required, placed_at, fulfilled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (order_id) DO UPDATE SET
         listing_id = EXCLUDED.listing_id,
         buyer_id = EXCLUDED.buyer_id,
         seller_id = EXCLUDED.seller_id,
         channel = EXCLUDED.channel,
         variant_id = EXCLUDED.variant_id,
         quantity = EXCLUDED.quantity,
         total_kobo = EXCLUDED.total_kobo,
         status = EXCLUDED.status,
         status_history_count = EXCLUDED.status_history_count,
         escrow_required = EXCLUDED.escrow_required,
         placed_at = EXCLUDED.placed_at,
         fulfilled_at = EXCLUDED.fulfilled_at,
         projected_at = now()`,
      [
        row.orderId,
        row.listingId,
        row.buyerId,
        row.sellerId,
        row.channel,
        row.variantId ?? null,
        row.quantity,
        row.totalKobo,
        row.status,
        row.statusHistoryCount,
        row.escrowRequired,
        row.placedAt,
        row.fulfilledAt ?? null
      ]
    );
    return row;
  }

  async upsertFactPayment(row: FactPaymentRow): Promise<FactPaymentRow> {
    await this.pool.query(
      `INSERT INTO analytics.fact_payments
         (entry_id, idempotency_key, reference_type, reference_id,
          debit_accounts, credit_accounts, amount_kobo, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (entry_id) DO UPDATE SET
         idempotency_key = EXCLUDED.idempotency_key,
         reference_type = EXCLUDED.reference_type,
         reference_id = EXCLUDED.reference_id,
         debit_accounts = EXCLUDED.debit_accounts,
         credit_accounts = EXCLUDED.credit_accounts,
         amount_kobo = EXCLUDED.amount_kobo,
         posted_at = EXCLUDED.posted_at,
         projected_at = now()`,
      [
        row.entryId,
        row.idempotencyKey,
        row.referenceType ?? null,
        row.referenceId ?? null,
        row.debitAccounts,
        row.creditAccounts,
        row.amountKobo,
        row.postedAt
      ]
    );
    return row;
  }

  async upsertFactLivestock(row: FactLivestockRow): Promise<FactLivestockRow> {
    await this.pool.query(
      `INSERT INTO analytics.fact_livestock
         (animal_id, owner_user_id, species, breed, state, status, registered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (animal_id) DO UPDATE SET
         owner_user_id = EXCLUDED.owner_user_id,
         species = EXCLUDED.species,
         breed = EXCLUDED.breed,
         state = EXCLUDED.state,
         status = EXCLUDED.status,
         registered_at = EXCLUDED.registered_at,
         projected_at = now()`,
      [row.animalId, row.ownerUserId, row.species, row.breed, row.state, row.status, row.registeredAt]
    );
    return row;
  }

  async upsertDailyMetric(row: DailyMetricRow): Promise<DailyMetricRow> {
    await this.pool.query(
      `INSERT INTO analytics.mart_daily_metrics
         (metric_date, orders_gmv_kobo, orders_count, active_farmers, escrow_held_kobo, livestock_registered)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (metric_date) DO UPDATE SET
         orders_gmv_kobo = EXCLUDED.orders_gmv_kobo,
         orders_count = EXCLUDED.orders_count,
         active_farmers = EXCLUDED.active_farmers,
         escrow_held_kobo = EXCLUDED.escrow_held_kobo,
         livestock_registered = EXCLUDED.livestock_registered,
         recomputed_at = now()`,
      [row.metricDate, row.ordersGmvKobo, row.ordersCount, row.activeFarmers, row.escrowHeldKobo, row.livestockRegistered]
    );
    return row;
  }

  async dimUsers(): Promise<DimUserRow[]> {
    const result = await this.pool.query(
      `SELECT user_id, roles, state, chapter_id, registered_at FROM analytics.dim_users ORDER BY user_id`
    );
    return result.rows.map((row) => ({
      userId: String(row.user_id),
      roles: (row.roles as string[]) ?? [],
      ...(row.state ? { state: String(row.state) } : {}),
      ...(row.chapter_id ? { chapterId: String(row.chapter_id) } : {}),
      registeredAt: ts(row.registered_at)
    }));
  }

  async dimListings(): Promise<DimListingRow[]> {
    const result = await this.pool.query(
      `SELECT listing_id, seller_id, kind, crop, state, created_at FROM analytics.dim_listings ORDER BY listing_id`
    );
    return result.rows.map((row) => ({
      listingId: String(row.listing_id),
      sellerId: String(row.seller_id),
      kind: String(row.kind),
      ...(row.crop ? { crop: String(row.crop) } : {}),
      ...(row.state ? { state: String(row.state) } : {}),
      createdAt: ts(row.created_at)
    }));
  }

  async factOrder(orderId: string): Promise<FactOrderRow | undefined> {
    const result = await this.pool.query(
      `SELECT order_id, listing_id, buyer_id, seller_id, channel, variant_id, quantity,
              total_kobo, status, status_history_count, escrow_required, placed_at, fulfilled_at
       FROM analytics.fact_orders WHERE order_id = $1`,
      [orderId]
    );
    const row = result.rows[0];
    return row ? mapFactOrder(row) : undefined;
  }

  async factOrders(range: MartDateRange = {}): Promise<FactOrderRow[]> {
    const result = await this.pool.query(
      `SELECT order_id, listing_id, buyer_id, seller_id, channel, variant_id, quantity,
              total_kobo, status, status_history_count, escrow_required, placed_at, fulfilled_at
       FROM analytics.fact_orders
       WHERE ($1::date IS NULL OR placed_at >= $1) AND ($2::date IS NULL OR placed_at < ($2::date + 1))
       ORDER BY placed_at, order_id`,
      [range.from ?? null, range.to ?? null]
    );
    return result.rows.map(mapFactOrder);
  }

  async factPayments(range: MartDateRange = {}): Promise<FactPaymentRow[]> {
    const result = await this.pool.query(
      `SELECT entry_id, idempotency_key, reference_type, reference_id,
              debit_accounts, credit_accounts, amount_kobo, posted_at
       FROM analytics.fact_payments
       WHERE ($1::date IS NULL OR posted_at >= $1) AND ($2::date IS NULL OR posted_at < ($2::date + 1))
       ORDER BY posted_at, entry_id`,
      [range.from ?? null, range.to ?? null]
    );
    return result.rows.map((row) => ({
      entryId: String(row.entry_id),
      idempotencyKey: String(row.idempotency_key),
      ...(row.reference_type ? { referenceType: String(row.reference_type) } : {}),
      ...(row.reference_id ? { referenceId: String(row.reference_id) } : {}),
      debitAccounts: (row.debit_accounts as string[]) ?? [],
      creditAccounts: (row.credit_accounts as string[]) ?? [],
      amountKobo: num(row.amount_kobo),
      postedAt: ts(row.posted_at)
    }));
  }

  async factLivestockEntry(animalId: string): Promise<FactLivestockRow | undefined> {
    const result = await this.pool.query(
      `SELECT animal_id, owner_user_id, species, breed, state, status, registered_at
       FROM analytics.fact_livestock WHERE animal_id = $1`,
      [animalId]
    );
    const row = result.rows[0];
    return row
      ? {
          animalId: String(row.animal_id),
          ownerUserId: String(row.owner_user_id),
          species: String(row.species),
          breed: String(row.breed),
          state: String(row.state),
          status: String(row.status),
          registeredAt: ts(row.registered_at)
        }
      : undefined;
  }

  async factLivestock(range: MartDateRange = {}): Promise<FactLivestockRow[]> {
    const result = await this.pool.query(
      `SELECT animal_id, owner_user_id, species, breed, state, status, registered_at
       FROM analytics.fact_livestock
       WHERE ($1::date IS NULL OR registered_at >= $1) AND ($2::date IS NULL OR registered_at < ($2::date + 1))
       ORDER BY registered_at, animal_id`,
      [range.from ?? null, range.to ?? null]
    );
    return result.rows.map((row) => ({
      animalId: String(row.animal_id),
      ownerUserId: String(row.owner_user_id),
      species: String(row.species),
      breed: String(row.breed),
      state: String(row.state),
      status: String(row.status),
      registeredAt: ts(row.registered_at)
    }));
  }

  async dailyMetrics(range: MartDateRange = {}): Promise<DailyMetricRow[]> {
    const result = await this.pool.query(
      `SELECT metric_date, orders_gmv_kobo, orders_count, active_farmers, escrow_held_kobo, livestock_registered
       FROM analytics.mart_daily_metrics
       WHERE ($1::date IS NULL OR metric_date >= $1) AND ($2::date IS NULL OR metric_date <= $2)
       ORDER BY metric_date`,
      [range.from ?? null, range.to ?? null]
    );
    return result.rows.map((row) => ({
      metricDate: dateKey(row.metric_date),
      ordersGmvKobo: num(row.orders_gmv_kobo),
      ordersCount: num(row.orders_count),
      activeFarmers: num(row.active_farmers),
      escrowHeldKobo: num(row.escrow_held_kobo),
      livestockRegistered: num(row.livestock_registered)
    }));
  }

  async recordProjection(consumer: string, update: ProjectionStateUpdate): Promise<void> {
    await this.pool.query(
      `INSERT INTO analytics.projection_state
         (consumer, last_run_at, last_event_id, last_event_at, processed_total)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (consumer) DO UPDATE SET
         last_run_at = EXCLUDED.last_run_at,
         last_event_id = COALESCE(EXCLUDED.last_event_id, analytics.projection_state.last_event_id),
         last_event_at = COALESCE(EXCLUDED.last_event_at, analytics.projection_state.last_event_at),
         processed_total = analytics.projection_state.processed_total + EXCLUDED.processed_total`,
      [consumer, update.lastRunAt, update.lastEventId ?? null, update.lastEventAt ?? null, update.processedDelta]
    );
  }

  async stats(consumer: string): Promise<AnalyticsStarStats> {
    const counts = await this.pool.query(
      `SELECT
         (SELECT count(*) FROM analytics.dim_users) AS dim_users,
         (SELECT count(*) FROM analytics.dim_listings) AS dim_listings,
         (SELECT count(*) FROM analytics.fact_orders) AS fact_orders,
         (SELECT count(*) FROM analytics.fact_payments) AS fact_payments,
         (SELECT count(*) FROM analytics.fact_livestock) AS fact_livestock,
         (SELECT count(*) FROM analytics.mart_daily_metrics) AS daily_metrics`
    );
    const projection = await this.pool.query(
      `SELECT last_run_at, last_event_id, last_event_at, processed_total
       FROM analytics.projection_state WHERE consumer = $1`,
      [consumer]
    );
    const row = counts.rows[0];
    const state = projection.rows[0];
    return {
      dimUsers: num(row.dim_users),
      dimListings: num(row.dim_listings),
      factOrders: num(row.fact_orders),
      factPayments: num(row.fact_payments),
      factLivestock: num(row.fact_livestock),
      dailyMetrics: num(row.daily_metrics),
      ...(state
        ? {
            projection: {
              lastRunAt: ts(state.last_run_at),
              ...(state.last_event_id ? { lastEventId: String(state.last_event_id) } : {}),
              ...(state.last_event_at ? { lastEventAt: ts(state.last_event_at) } : {}),
              processedTotal: num(state.processed_total)
            }
          }
        : {})
    };
  }
}

function mapFactOrder(row: Record<string, unknown>): FactOrderRow {
  return {
    orderId: String(row.order_id),
    listingId: String(row.listing_id),
    buyerId: String(row.buyer_id),
    sellerId: String(row.seller_id),
    channel: String(row.channel),
    ...(row.variant_id ? { variantId: String(row.variant_id) } : {}),
    quantity: num(row.quantity),
    totalKobo: num(row.total_kobo),
    status: String(row.status),
    statusHistoryCount: num(row.status_history_count),
    escrowRequired: Boolean(row.escrow_required),
    placedAt: ts(row.placed_at),
    ...(row.fulfilled_at ? { fulfilledAt: ts(row.fulfilled_at) } : {})
  };
}

/** date row value → 'YYYY-MM-DD' (pg returns Date objects for DATE columns). */
function dateKey(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

export function createPgAnalyticsStarRepository(pool: pg.Pool): PgAnalyticsStarRepository {
  return new PgAnalyticsStarRepository(pool);
}
