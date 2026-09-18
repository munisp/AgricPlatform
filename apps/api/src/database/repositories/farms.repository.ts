import type {
  CropPlanting,
  FarmExpense,
  FarmExpenseAllocation,
  FarmPlot,
  HarvestRecord,
  PlantingStatus
} from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/**
 * Farms & crop-production persistence ports (farms wave, infra/postgres/022).
 * The in-memory implementations mirror the pg semantics so unit tests keep
 * full fidelity; production swaps them behind the same port via the
 * DatabaseModule factories.
 */

export interface FarmPlotCriteria {
  ownerUserId?: string;
  state?: string;
  lga?: string;
}

export interface FarmPlotRepository extends AsyncRepository<FarmPlot, FarmPlotCriteria> {}

export function farmPlotMatcher(criteria: FarmPlotCriteria): (plot: FarmPlot) => boolean {
  return (plot) =>
    (!criteria.ownerUserId || plot.ownerUserId === criteria.ownerUserId) &&
    (!criteria.state || plot.state === criteria.state) &&
    (!criteria.lga || plot.lga === criteria.lga);
}

export class InMemoryFarmPlotRepository
  extends InMemoryRepository<FarmPlot, FarmPlotCriteria>
  implements FarmPlotRepository
{
  constructor(seed: readonly FarmPlot[] = []) {
    super(seed, farmPlotMatcher);
  }
}

export function createInMemoryFarmPlotRepository(
  seed: readonly FarmPlot[] = []
): InMemoryFarmPlotRepository {
  return new InMemoryFarmPlotRepository(seed);
}

// ---------------------------------------------------------------------------

export interface CropPlantingCriteria {
  plotId?: string;
  crop?: string;
  season?: string;
  status?: PlantingStatus;
}

export interface CropPlantingRepository
  extends AsyncRepository<CropPlanting, CropPlantingCriteria> {}

export function cropPlantingMatcher(
  criteria: CropPlantingCriteria
): (planting: CropPlanting) => boolean {
  return (planting) =>
    (!criteria.plotId || planting.plotId === criteria.plotId) &&
    (!criteria.crop || planting.crop === criteria.crop) &&
    (!criteria.season || planting.season === criteria.season) &&
    (!criteria.status || planting.status === criteria.status);
}

export class InMemoryCropPlantingRepository
  extends InMemoryRepository<CropPlanting, CropPlantingCriteria>
  implements CropPlantingRepository
{
  constructor(seed: readonly CropPlanting[] = []) {
    super(seed, cropPlantingMatcher);
  }
}

export function createInMemoryCropPlantingRepository(
  seed: readonly CropPlanting[] = []
): InMemoryCropPlantingRepository {
  return new InMemoryCropPlantingRepository(seed);
}

// ---------------------------------------------------------------------------

export interface HarvestRecordCriteria {
  plantingId?: string;
}

export interface HarvestRecordRepository
  extends AsyncRepository<HarvestRecord, HarvestRecordCriteria> {}

export function harvestRecordMatcher(
  criteria: HarvestRecordCriteria
): (harvest: HarvestRecord) => boolean {
  return (harvest) => !criteria.plantingId || harvest.plantingId === criteria.plantingId;
}

export class InMemoryHarvestRecordRepository
  extends InMemoryRepository<HarvestRecord, HarvestRecordCriteria>
  implements HarvestRecordRepository
{
  constructor(seed: readonly HarvestRecord[] = []) {
    super(seed, harvestRecordMatcher);
  }
}

export function createInMemoryHarvestRecordRepository(
  seed: readonly HarvestRecord[] = []
): InMemoryHarvestRecordRepository {
  return new InMemoryHarvestRecordRepository(seed);
}

// ---------------------------------------------------------------------------

export interface FarmExpenseCriteria {
  plotId?: string;
  category?: FarmExpense['category'];
}

export interface FarmExpenseRepository
  extends AsyncRepository<FarmExpense, FarmExpenseCriteria> {}

export function farmExpenseMatcher(criteria: FarmExpenseCriteria): (expense: FarmExpense) => boolean {
  return (expense) =>
    (!criteria.plotId || expense.plotId === criteria.plotId) &&
    (!criteria.category || expense.category === criteria.category);
}

export class InMemoryFarmExpenseRepository
  extends InMemoryRepository<FarmExpense, FarmExpenseCriteria>
  implements FarmExpenseRepository
{
  constructor(seed: readonly FarmExpense[] = []) {
    super(seed, farmExpenseMatcher);
  }
}

export function createInMemoryFarmExpenseRepository(
  seed: readonly FarmExpense[] = []
): InMemoryFarmExpenseRepository {
  return new InMemoryFarmExpenseRepository(seed);
}

// ---------------------------------------------------------------------------

/**
 * Intercrop expense allocation port (W2-FP4 A4; migration
 * 117_farms_expense_allocations.sql). Allocations are write-once: they are
 * recorded atomically with the expense's creation and never updated (a
 * corrected expense is a new expense). Rows keyed by (expenseId,
 * plantingId) on pg.
 */
export interface ExpenseAllocationRow extends FarmExpenseAllocation {
  expenseId: string;
}

export interface FarmExpenseAllocationRepository {
  /** Persists the explicit shares for one expense (write-once). */
  record(expenseId: string, allocations: readonly FarmExpenseAllocation[]): Promise<void>;
  /** All allocation rows for the given expenses (read-side join). */
  listForExpenses(expenseIds: readonly string[]): Promise<ExpenseAllocationRow[]>;
  /** All allocation rows touching one planting (per-crop P&L reads). */
  listForPlanting(plantingId: string): Promise<ExpenseAllocationRow[]>;
}

export class InMemoryFarmExpenseAllocationRepository implements FarmExpenseAllocationRepository {
  private readonly rows: ExpenseAllocationRow[] = [];

  async record(expenseId: string, allocations: readonly FarmExpenseAllocation[]): Promise<void> {
    for (const allocation of allocations) {
      this.rows.push({ expenseId, ...allocation });
    }
  }

  async listForExpenses(expenseIds: readonly string[]): Promise<ExpenseAllocationRow[]> {
    const wanted = new Set(expenseIds);
    return this.rows.filter((row) => wanted.has(row.expenseId)).map((row) => ({ ...row }));
  }

  async listForPlanting(plantingId: string): Promise<ExpenseAllocationRow[]> {
    return this.rows.filter((row) => row.plantingId === plantingId).map((row) => ({ ...row }));
  }
}

export function createInMemoryFarmExpenseAllocationRepository(): InMemoryFarmExpenseAllocationRepository {
  return new InMemoryFarmExpenseAllocationRepository();
}
