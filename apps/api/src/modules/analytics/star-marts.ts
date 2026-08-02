/**
 * Wave B star-schema mart rows (analytics schema, migration 019). These are
 * the REAL analytical store — there is no Spark/Iceberg/Trino deployment;
 * the lakehouse upgrade path is documented in docs/analytics-lakehouse.md.
 *
 * Rows are keyed by natural keys (order_id, entry_id, animal_id, user_id,
 * listing_id, metric_date) so the outbox→mart projector can upsert
 * idempotently: replaying the full outbox history yields identical marts.
 * Column layouts mirror the CSV export contract 1:1 (parquet-ready).
 */

/** analytics.dim_users — member dimension (roles, state, chapter). */
export interface DimUserRow {
  userId: string;
  roles: string[];
  /** Profile location.state; null when the member has no profile yet. */
  state?: string;
  /**
   * Chapter the member LEADS. Per-member chapter affiliation is not
   * modelled in the OLTP schema, so this column is sparsely populated —
   * documented in docs/analytics-lakehouse.md.
   */
  chapterId?: string;
  registeredAt: string;
}

/** analytics.dim_listings — listing dimension (kind, crop, state). */
export interface DimListingRow {
  listingId: string;
  sellerId: string;
  kind: string;
  crop?: string;
  state?: string;
  createdAt: string;
}

/** analytics.fact_orders — one row per marketplace order. */
export interface FactOrderRow {
  orderId: string;
  listingId: string;
  buyerId: string;
  sellerId: string;
  /** Sales channel from the order_extensions side table (web|mobile|agent). */
  channel: string;
  variantId?: string;
  quantity: number;
  totalKobo: number;
  status: string;
  /** Count of marketplace.order.status_changed events applied to this row. */
  statusHistoryCount: number;
  escrowRequired: boolean;
  placedAt: string;
  /** Set when the order status first reaches 'completed'. */
  fulfilledAt?: string;
}

/** analytics.fact_payments — one row per double-entry journal entry. */
export interface FactPaymentRow {
  entryId: string;
  idempotencyKey: string;
  /** Transfer type (ledger reference_type, e.g. marketplace_order|payout|fee). */
  referenceType?: string;
  referenceId?: string;
  debitAccounts: string[];
  creditAccounts: string[];
  /** Balanced-entry total (sum of debits == sum of credits). */
  amountKobo: number;
  postedAt: string;
}

/** analytics.fact_livestock — one row per registered animal. */
export interface FactLivestockRow {
  animalId: string;
  ownerUserId: string;
  species: string;
  breed: string;
  state: string;
  status: string;
  registeredAt: string;
}

/**
 * analytics.mart_daily_metrics — Lagos-calendar-day rollups, recomputed
 * from the fact tables + escrow records (never incremented), so replays are
 * deterministic. Definitions:
 *   ordersGmvKobo   sum(totalKobo) of orders PLACED on the date
 *   ordersCount     orders placed on the date
 *   activeFarmers   distinct sellers with >= 1 order placed on the date
 *   escrowHeldKobo  escrow exposure at end of the Lagos day
 *   livestockRegistered  animals registered on the date
 */
export interface DailyMetricRow {
  metricDate: string;
  ordersGmvKobo: number;
  ordersCount: number;
  activeFarmers: number;
  escrowHeldKobo: number;
  livestockRegistered: number;
}

/** Mart table names accepted by the CSV export endpoint. */
export const STAR_FACT_NAMES = ['fact_orders', 'fact_payments'] as const;
export type StarFactName = (typeof STAR_FACT_NAMES)[number];
