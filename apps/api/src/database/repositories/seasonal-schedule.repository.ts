import { ConflictException, NotFoundException } from '@nestjs/common';
import type {
  CreditSeasonalSchedule,
  CreditSeasonalScheduleStatus
} from '@agric-platform/shared';

/**
 * Seasonal schedule repository port (SeasonSync, migration 055
 * credit.seasonal_schedules). Rows are append-only previews: a re-preview
 * creates a new per-loan version; the only mutation is the guarded status
 * CAS previewed → accepted | superseded. Exactly one accepted schedule per
 * loan is enforced by the partial unique index on PostgreSQL and by the
 * in-memory CAS below.
 */

export interface SeasonalScheduleCriteria {
  loanId?: string;
  status?: CreditSeasonalScheduleStatus;
}

export interface SeasonalScheduleRepository {
  create(record: CreditSeasonalSchedule): Promise<CreditSeasonalSchedule>;
  findById(id: string): Promise<CreditSeasonalSchedule | undefined>;
  /** Throws NotFoundException when the id does not exist. */
  getById(id: string): Promise<CreditSeasonalSchedule>;
  find(criteria: SeasonalScheduleCriteria): Promise<CreditSeasonalSchedule[]>;
  /**
   * Compare-and-set status transition: applies only when the stored status
   * still equals `expected`; throws ConflictException otherwise (a
   * concurrent accept won the race — the caller surfaces 409).
   */
  updateStatusExpected(
    id: string,
    to: CreditSeasonalScheduleStatus,
    expected: CreditSeasonalScheduleStatus,
    extra?: Partial<Pick<CreditSeasonalSchedule, 'acceptedAt'>>
  ): Promise<CreditSeasonalSchedule>;
}

export function seasonalScheduleMatcher(
  criteria: SeasonalScheduleCriteria
): (record: CreditSeasonalSchedule) => boolean {
  return (record) =>
    (!criteria.loanId || record.loanId === criteria.loanId) &&
    (!criteria.status || record.status === criteria.status);
}

export class InMemorySeasonalScheduleRepository implements SeasonalScheduleRepository {
  private readonly items = new Map<string, CreditSeasonalSchedule>();

  constructor(seed: readonly CreditSeasonalSchedule[] = []) {
    for (const record of seed) {
      this.items.set(record.id, structuredClone(record));
    }
  }

  async create(record: CreditSeasonalSchedule): Promise<CreditSeasonalSchedule> {
    if (this.items.has(record.id)) {
      throw new ConflictException(`Seasonal schedule ${record.id} already exists`);
    }
    this.assertSingleAccepted(record);
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<CreditSeasonalSchedule | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async getById(id: string): Promise<CreditSeasonalSchedule> {
    const record = await this.findById(id);
    if (!record) {
      throw new NotFoundException(`Seasonal schedule ${id} not found`);
    }
    return record;
  }

  async find(criteria: SeasonalScheduleCriteria): Promise<CreditSeasonalSchedule[]> {
    return [...this.items.values()]
      .filter(seasonalScheduleMatcher(criteria))
      .sort((a, b) => a.version - b.version)
      .map((record) => structuredClone(record));
  }

  async updateStatusExpected(
    id: string,
    to: CreditSeasonalScheduleStatus,
    expected: CreditSeasonalScheduleStatus,
    extra: Partial<Pick<CreditSeasonalSchedule, 'acceptedAt'>> = {}
  ): Promise<CreditSeasonalSchedule> {
    const current = await this.getById(id);
    if (current.status !== expected) {
      throw new ConflictException(
        `Seasonal schedule ${id} is '${current.status}', expected '${expected}'`
      );
    }
    const next: CreditSeasonalSchedule = { ...current, ...extra, status: to };
    this.assertSingleAccepted(next, id);
    this.items.set(id, structuredClone(next));
    return structuredClone(next);
  }

  private assertSingleAccepted(record: CreditSeasonalSchedule, ignoreId?: string): void {
    if (record.status !== 'accepted') {
      return;
    }
    const clash = [...this.items.values()].find(
      (item) => item.loanId === record.loanId && item.status === 'accepted' && item.id !== ignoreId
    );
    if (clash) {
      throw new ConflictException(
        `Loan ${record.loanId} already has an accepted seasonal schedule (${clash.id})`
      );
    }
  }
}

export function createInMemorySeasonalScheduleRepository(
  seed: readonly CreditSeasonalSchedule[] = []
): InMemorySeasonalScheduleRepository {
  return new InMemorySeasonalScheduleRepository(seed);
}
