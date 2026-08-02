import { Inject, Injectable } from '@nestjs/common';
import { ANALYTICS_STAR_REPOSITORY, ESCROW_REPOSITORY } from '../../database/persistence.tokens.js';
import type { MartDateRange } from '../../database/repositories/analytics-mart.repository.js';
import type {
  AnalyticsStarRepository,
  AnalyticsStarStats
} from '../../database/repositories/analytics-star.repository.js';
import type { EscrowRepository } from '../../database/repositories/escrow.repository.js';
import { toCsv, type CsvRow } from './export-formats.js';
import { ANALYTICS_PROJECTOR_CONSUMER } from './projector.service.js';
import type { DailyMetricRow, FactOrderRow, FactPaymentRow, StarFactName } from './star-marts.js';

/** Cross-mart headline numbers for the admin summary card. */
export interface AnalyticsSummary {
  /** Sum of totalKobo across all non-cancelled fact orders. */
  gmvKobo: number;
  /** Non-cancelled fact orders. */
  ordersCount: number;
  /** Escrow exposure right now (held / releasing / refunding / disputed). */
  escrowHeldKobo: number;
  /** Registered animals in the livestock fact. */
  livestockRegistered: number;
  /** Members / listings in the dimensions. */
  members: number;
  listings: number;
  /** Projector heartbeat (null until the first projection run). */
  lastProjectionAt: string | null;
  generatedAt: string;
}

/** Escrow statuses that count as open exposure for the summary gauge. */
const OPEN_ESCROW_STATUSES = new Set(['held', 'releasing', 'refunding', 'disputed']);

/**
 * Read side of the Wave B star marts: daily metric ranges, the headline
 * summary and the lakehouse-handoff CSV exports. Writes happen exclusively
 * through AnalyticsProjectorService.
 */
@Injectable()
export class AnalyticsStarService {
  constructor(
    @Inject(ANALYTICS_STAR_REPOSITORY) private readonly star: AnalyticsStarRepository,
    @Inject(ESCROW_REPOSITORY) private readonly escrows: EscrowRepository
  ) {}

  async dailyMetrics(range: MartDateRange = {}): Promise<DailyMetricRow[]> {
    return this.star.dailyMetrics(range);
  }

  async summary(): Promise<AnalyticsSummary> {
    const [orders, livestock, escrows, stats] = await Promise.all([
      this.star.factOrders(),
      this.star.factLivestock(),
      this.escrows.find({}),
      this.star.stats(ANALYTICS_PROJECTOR_CONSUMER)
    ]);
    const counted = orders.filter((order) => order.status !== 'cancelled');
    return {
      gmvKobo: counted.reduce((total, order) => total + order.totalKobo, 0),
      ordersCount: counted.length,
      escrowHeldKobo: escrows
        .filter((record) => OPEN_ESCROW_STATUSES.has(record.status))
        .reduce((total, record) => total + record.amountKobo, 0),
      livestockRegistered: livestock.length,
      members: stats.dimUsers,
      listings: stats.dimListings,
      lastProjectionAt: stats.projection?.lastRunAt ?? null,
      generatedAt: new Date().toISOString()
    };
  }

  /** Health-probe data: mart row counts + projector heartbeat. */
  async stats(): Promise<AnalyticsStarStats> {
    return this.star.stats(ANALYTICS_PROJECTOR_CONSUMER);
  }

  async factOrders(range: MartDateRange = {}): Promise<FactOrderRow[]> {
    return this.star.factOrders(range);
  }

  async factPayments(range: MartDateRange = {}): Promise<FactPaymentRow[]> {
    return this.star.factPayments(range);
  }

  /**
   * Lakehouse handoff: RFC 4180 CSV mirroring the star-table columns 1:1
   * (the parquet-ready contract documented in docs/analytics-lakehouse.md).
   */
  async factCsv(fact: StarFactName, range: MartDateRange = {}): Promise<string> {
    if (fact === 'fact_orders') {
      return factOrdersCsv(await this.star.factOrders(range));
    }
    return factPaymentsCsv(await this.star.factPayments(range));
  }
}

export const FACT_ORDERS_CSV_HEADER = [
  'order_id',
  'listing_id',
  'buyer_id',
  'seller_id',
  'channel',
  'variant_id',
  'quantity',
  'total_kobo',
  'status',
  'status_history_count',
  'escrow_required',
  'placed_at',
  'fulfilled_at'
] as const;

export const FACT_PAYMENTS_CSV_HEADER = [
  'entry_id',
  'idempotency_key',
  'reference_type',
  'reference_id',
  'debit_accounts',
  'credit_accounts',
  'amount_kobo',
  'posted_at'
] as const;

export function factOrdersCsv(rows: readonly FactOrderRow[]): string {
  const csvRows: CsvRow[] = [
    [...FACT_ORDERS_CSV_HEADER],
    ...rows.map((row): CsvRow => [
      row.orderId,
      row.listingId,
      row.buyerId,
      row.sellerId,
      row.channel,
      row.variantId,
      row.quantity,
      row.totalKobo,
      row.status,
      row.statusHistoryCount,
      row.escrowRequired,
      row.placedAt,
      row.fulfilledAt
    ])
  ];
  return toCsv(csvRows);
}

export function factPaymentsCsv(rows: readonly FactPaymentRow[]): string {
  const csvRows: CsvRow[] = [
    [...FACT_PAYMENTS_CSV_HEADER],
    ...rows.map((row): CsvRow => [
      row.entryId,
      row.idempotencyKey,
      row.referenceType,
      row.referenceId,
      // Array columns are ';'-joined so the CSV stays RFC 4180 single-line
      // per record; the lakehouse loader splits on ';' into ARRAY[...].
      row.debitAccounts.join(';'),
      row.creditAccounts.join(';'),
      row.amountKobo,
      row.postedAt
    ])
  ];
  return toCsv(csvRows);
}
