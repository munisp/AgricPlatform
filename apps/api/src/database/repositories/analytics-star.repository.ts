import type {
  DailyMetricRow,
  DimListingRow,
  DimUserRow,
  FactLivestockRow,
  FactOrderRow,
  FactPaymentRow
} from '../../modules/analytics/star-marts.js';
import type { MartDateRange } from './analytics-mart.repository.js';

/** Row counts per star table + projector heartbeat (health probe). */
export interface AnalyticsStarStats {
  dimUsers: number;
  dimListings: number;
  factOrders: number;
  factPayments: number;
  factLivestock: number;
  dailyMetrics: number;
  /** analytics.projection_state for the projector consumer, when present. */
  projection?: {
    lastRunAt: string;
    lastEventId?: string;
    lastEventAt?: string;
    processedTotal: number;
  };
}

export interface ProjectionStateUpdate {
  lastRunAt: string;
  lastEventId?: string;
  lastEventAt?: string;
  /** Number of events applied in this run (added to the running total). */
  processedDelta: number;
}

/**
 * Star-schema mart port (Wave B, analytics schema, migration 019). Upserts
 * are keyed by natural keys so the outbox→mart projector is idempotent and
 * catch-up safe: replaying the outbox history reproduces identical marts.
 * Date ranges are inclusive 'YYYY-MM-DD' bounds on placed_at / posted_at /
 * metric_date (Lagos calendar days).
 */
export interface AnalyticsStarRepository {
  upsertDimUser(row: DimUserRow): Promise<DimUserRow>;
  upsertDimListing(row: DimListingRow): Promise<DimListingRow>;
  upsertFactOrder(row: FactOrderRow): Promise<FactOrderRow>;
  upsertFactPayment(row: FactPaymentRow): Promise<FactPaymentRow>;
  upsertFactLivestock(row: FactLivestockRow): Promise<FactLivestockRow>;
  upsertDailyMetric(row: DailyMetricRow): Promise<DailyMetricRow>;

  dimUsers(): Promise<DimUserRow[]>;
  dimListings(): Promise<DimListingRow[]>;
  factOrder(orderId: string): Promise<FactOrderRow | undefined>;
  factOrders(range?: MartDateRange): Promise<FactOrderRow[]>;
  factPayments(range?: MartDateRange): Promise<FactPaymentRow[]>;
  factLivestockEntry(animalId: string): Promise<FactLivestockRow | undefined>;
  factLivestock(range?: MartDateRange): Promise<FactLivestockRow[]>;
  dailyMetrics(range?: MartDateRange): Promise<DailyMetricRow[]>;

  recordProjection(consumer: string, update: ProjectionStateUpdate): Promise<void>;
  stats(consumer: string): Promise<AnalyticsStarStats>;
}

const inRange = (iso: string, range?: MartDateRange): boolean => {
  const day = iso.slice(0, 10);
  return (!range?.from || day >= range.from) && (!range?.to || day <= range.to);
};

const byDate = <T extends { metricDate: string }>(a: T, b: T): number =>
  a.metricDate.localeCompare(b.metricDate);

export class InMemoryAnalyticsStarRepository implements AnalyticsStarRepository {
  private readonly dimUserRows = new Map<string, DimUserRow>();
  private readonly dimListingRows = new Map<string, DimListingRow>();
  private readonly factOrderRows = new Map<string, FactOrderRow>();
  private readonly factPaymentRows = new Map<string, FactPaymentRow>();
  private readonly factLivestockRows = new Map<string, FactLivestockRow>();
  private readonly dailyMetricRows = new Map<string, DailyMetricRow>();
  private readonly projections = new Map<
    string,
    { lastRunAt: string; lastEventId?: string; lastEventAt?: string; processedTotal: number }
  >();

  async upsertDimUser(row: DimUserRow): Promise<DimUserRow> {
    this.dimUserRows.set(row.userId, { ...row, roles: [...row.roles] });
    return row;
  }

  async upsertDimListing(row: DimListingRow): Promise<DimListingRow> {
    this.dimListingRows.set(row.listingId, { ...row });
    return row;
  }

  async upsertFactOrder(row: FactOrderRow): Promise<FactOrderRow> {
    this.factOrderRows.set(row.orderId, { ...row });
    return row;
  }

  async upsertFactPayment(row: FactPaymentRow): Promise<FactPaymentRow> {
    this.factPaymentRows.set(row.entryId, {
      ...row,
      debitAccounts: [...row.debitAccounts],
      creditAccounts: [...row.creditAccounts]
    });
    return row;
  }

  async upsertFactLivestock(row: FactLivestockRow): Promise<FactLivestockRow> {
    this.factLivestockRows.set(row.animalId, { ...row });
    return row;
  }

  async upsertDailyMetric(row: DailyMetricRow): Promise<DailyMetricRow> {
    this.dailyMetricRows.set(row.metricDate, { ...row });
    return row;
  }

  async dimUsers(): Promise<DimUserRow[]> {
    return [...this.dimUserRows.values()].map((row) => ({ ...row, roles: [...row.roles] }));
  }

  async dimListings(): Promise<DimListingRow[]> {
    return [...this.dimListingRows.values()].map((row) => ({ ...row }));
  }

  async factOrder(orderId: string): Promise<FactOrderRow | undefined> {
    const row = this.factOrderRows.get(orderId);
    return row ? { ...row } : undefined;
  }

  async factOrders(range?: MartDateRange): Promise<FactOrderRow[]> {
    return [...this.factOrderRows.values()]
      .filter((row) => inRange(row.placedAt, range))
      .sort((a, b) => a.placedAt.localeCompare(b.placedAt) || a.orderId.localeCompare(b.orderId))
      .map((row) => ({ ...row }));
  }

  async factPayments(range?: MartDateRange): Promise<FactPaymentRow[]> {
    return [...this.factPaymentRows.values()]
      .filter((row) => inRange(row.postedAt, range))
      .sort((a, b) => a.postedAt.localeCompare(b.postedAt) || a.entryId.localeCompare(b.entryId))
      .map((row) => ({ ...row, debitAccounts: [...row.debitAccounts], creditAccounts: [...row.creditAccounts] }));
  }

  async factLivestockEntry(animalId: string): Promise<FactLivestockRow | undefined> {
    const row = this.factLivestockRows.get(animalId);
    return row ? { ...row } : undefined;
  }

  async factLivestock(range?: MartDateRange): Promise<FactLivestockRow[]> {
    return [...this.factLivestockRows.values()]
      .filter((row) => inRange(row.registeredAt, range))
      .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt) || a.animalId.localeCompare(b.animalId))
      .map((row) => ({ ...row }));
  }

  async dailyMetrics(range?: MartDateRange): Promise<DailyMetricRow[]> {
    return [...this.dailyMetricRows.values()]
      .filter((row) => inRange(`${row.metricDate}T00:00:00.000Z`, range))
      .sort(byDate)
      .map((row) => ({ ...row }));
  }

  async recordProjection(consumer: string, update: ProjectionStateUpdate): Promise<void> {
    const current = this.projections.get(consumer) ?? {
      lastRunAt: update.lastRunAt,
      processedTotal: 0
    };
    this.projections.set(consumer, {
      lastRunAt: update.lastRunAt,
      ...(update.lastEventId ? { lastEventId: update.lastEventId } : current.lastEventId ? { lastEventId: current.lastEventId } : {}),
      ...(update.lastEventAt ? { lastEventAt: update.lastEventAt } : current.lastEventAt ? { lastEventAt: current.lastEventAt } : {}),
      processedTotal: current.processedTotal + update.processedDelta
    });
  }

  async stats(consumer: string): Promise<AnalyticsStarStats> {
    const projection = this.projections.get(consumer);
    return {
      dimUsers: this.dimUserRows.size,
      dimListings: this.dimListingRows.size,
      factOrders: this.factOrderRows.size,
      factPayments: this.factPaymentRows.size,
      factLivestock: this.factLivestockRows.size,
      dailyMetrics: this.dailyMetricRows.size,
      ...(projection ? { projection: { ...projection } } : {})
    };
  }
}

export function createInMemoryAnalyticsStarRepository(): InMemoryAnalyticsStarRepository {
  return new InMemoryAnalyticsStarRepository();
}
