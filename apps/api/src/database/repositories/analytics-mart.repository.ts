import type {
  MartLearningDaily,
  MartMarketplaceDaily,
  MartMemberKpisDaily
} from '../../modules/analytics/marts.js';

/**
 * Analytics data-mart port (Wave P5c). Mart rows are keyed by snapshot_date
 * (Lagos calendar day), not by an id — upserts make the ETL snapshot
 * idempotent per date and safe to re-run.
 */
export interface MartDateRange {
  /** Inclusive lower bound, 'YYYY-MM-DD'. */
  from?: string;
  /** Inclusive upper bound, 'YYYY-MM-DD'. */
  to?: string;
}

export interface AnalyticsMartRepository {
  upsertMemberKpis(row: MartMemberKpisDaily): Promise<MartMemberKpisDaily>;
  upsertMarketplace(row: MartMarketplaceDaily): Promise<MartMarketplaceDaily>;
  upsertLearning(row: MartLearningDaily): Promise<MartLearningDaily>;
  memberKpis(range?: MartDateRange): Promise<MartMemberKpisDaily[]>;
  marketplaceDaily(range?: MartDateRange): Promise<MartMarketplaceDaily[]>;
  learningDaily(range?: MartDateRange): Promise<MartLearningDaily[]>;
}

const inRange = (date: string, range?: MartDateRange): boolean =>
  (!range?.from || date >= range.from) && (!range?.to || date <= range.to);

const byDate = <T extends { snapshotDate: string }>(a: T, b: T): number =>
  a.snapshotDate.localeCompare(b.snapshotDate);

export class InMemoryAnalyticsMartRepository implements AnalyticsMartRepository {
  private readonly memberKpisRows = new Map<string, MartMemberKpisDaily>();
  private readonly marketplaceRows = new Map<string, MartMarketplaceDaily>();
  private readonly learningRows = new Map<string, MartLearningDaily>();

  async upsertMemberKpis(row: MartMemberKpisDaily): Promise<MartMemberKpisDaily> {
    this.memberKpisRows.set(row.snapshotDate, { ...row });
    return row;
  }

  async upsertMarketplace(row: MartMarketplaceDaily): Promise<MartMarketplaceDaily> {
    this.marketplaceRows.set(row.snapshotDate, { ...row });
    return row;
  }

  async upsertLearning(row: MartLearningDaily): Promise<MartLearningDaily> {
    this.learningRows.set(row.snapshotDate, { ...row });
    return row;
  }

  async memberKpis(range?: MartDateRange): Promise<MartMemberKpisDaily[]> {
    return [...this.memberKpisRows.values()]
      .filter((row) => inRange(row.snapshotDate, range))
      .sort(byDate);
  }

  async marketplaceDaily(range?: MartDateRange): Promise<MartMarketplaceDaily[]> {
    return [...this.marketplaceRows.values()]
      .filter((row) => inRange(row.snapshotDate, range))
      .sort(byDate);
  }

  async learningDaily(range?: MartDateRange): Promise<MartLearningDaily[]> {
    return [...this.learningRows.values()]
      .filter((row) => inRange(row.snapshotDate, range))
      .sort(byDate);
  }
}

export function createInMemoryAnalyticsMartRepository(): InMemoryAnalyticsMartRepository {
  return new InMemoryAnalyticsMartRepository();
}
