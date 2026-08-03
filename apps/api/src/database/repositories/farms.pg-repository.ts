import type pg from 'pg';
import type {
  CropPlanting,
  FarmExpense,
  FarmPlot,
  HarvestRecord
} from '@agric-platform/shared';
import {
  composeWhere,
  eq,
  num,
  PgRepositoryBase,
  ts,
  type RowMapper,
  type WhereClause
} from '../pg/pg-repository.base.js';
import type {
  CropPlantingCriteria,
  CropPlantingRepository,
  FarmExpenseCriteria,
  FarmExpenseRepository,
  FarmPlotCriteria,
  FarmPlotRepository,
  HarvestRecordCriteria,
  HarvestRecordRepository
} from './farms.repository.js';

/**
 * Farms & crop-production pg implementations (farms wave, farms schema,
 * migration 022). PK columns are plain `id`, so the base id-keyed methods
 * apply unchanged; mappers are local to keep the farms wave self-contained.
 * toRow only emits keys present on the item so Partial<T> patches update
 * exactly the patched columns (present-but-undefined → SQL NULL = clearing).
 */

function present<T extends object>(
  item: Partial<T>,
  mapping: Record<string, keyof Partial<T>>
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [column, key] of Object.entries(mapping)) {
    if (key in item) {
      const value = (item as Record<string, unknown>)[key as string];
      row[column] = value === undefined ? null : value;
    }
  }
  return row;
}

const FARM_PLOT_MAPPING = {
  id: 'id',
  owner_user_id: 'ownerUserId',
  name: 'name',
  state: 'state',
  lga: 'lga',
  centroid_lat: 'centroidLat',
  centroid_long: 'centroidLong',
  boundary_geojson: 'boundaryGeojson',
  size_hectares: 'sizeHectares',
  soil_type: 'soilType',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  version: 'version',
  client_id: 'clientId'
} as const;

export const farmPlotMapper: RowMapper<FarmPlot> = {
  columns: Object.keys(FARM_PLOT_MAPPING),
  fromRow: (row) => ({
    id: row.id as string,
    ownerUserId: row.owner_user_id as string,
    name: row.name as string,
    state: row.state as string,
    lga: row.lga as string,
    centroidLat: num(row.centroid_lat),
    centroidLong: num(row.centroid_long),
    boundaryGeojson: row.boundary_geojson ?? undefined,
    sizeHectares: num(row.size_hectares),
    soilType: (row.soil_type as FarmPlot['soilType']) ?? undefined,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
    version: num(row.version),
    clientId: (row.client_id as string | null) ?? undefined
  }),
  toRow: (item) => present(item, FARM_PLOT_MAPPING)
};

export function farmPlotCriteriaSql(criteria: FarmPlotCriteria): WhereClause {
  return composeWhere(
    eq('owner_user_id', criteria.ownerUserId),
    eq('state', criteria.state),
    eq('lga', criteria.lga)
  );
}

export class PgFarmPlotRepository
  extends PgRepositoryBase<FarmPlot, FarmPlotCriteria>
  implements FarmPlotRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'farms.farm_plots',
      mapper: farmPlotMapper,
      criteria: farmPlotCriteriaSql
    });
  }
}

export function createPgFarmPlotRepository(pool: pg.Pool): PgFarmPlotRepository {
  return new PgFarmPlotRepository(pool);
}

// ---------------------------------------------------------------------------

const CROP_PLANTING_MAPPING = {
  id: 'id',
  plot_id: 'plotId',
  crop: 'crop',
  variety: 'variety',
  season: 'season',
  planted_at: 'plantedAt',
  expected_harvest_at: 'expectedHarvestAt',
  status: 'status',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  version: 'version',
  client_id: 'clientId'
} as const;

export const cropPlantingMapper: RowMapper<CropPlanting> = {
  columns: Object.keys(CROP_PLANTING_MAPPING),
  fromRow: (row) => ({
    id: row.id as string,
    plotId: row.plot_id as string,
    crop: row.crop as string,
    variety: (row.variety as string | null) ?? undefined,
    season: row.season as string,
    plantedAt: ts(row.planted_at),
    expectedHarvestAt: row.expected_harvest_at ? ts(row.expected_harvest_at) : undefined,
    status: row.status as CropPlanting['status'],
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at),
    version: num(row.version),
    clientId: (row.client_id as string | null) ?? undefined
  }),
  toRow: (item) => present(item, CROP_PLANTING_MAPPING)
};

export function cropPlantingCriteriaSql(criteria: CropPlantingCriteria): WhereClause {
  return composeWhere(
    eq('plot_id', criteria.plotId),
    eq('crop', criteria.crop),
    eq('season', criteria.season),
    eq('status', criteria.status)
  );
}

export class PgCropPlantingRepository
  extends PgRepositoryBase<CropPlanting, CropPlantingCriteria>
  implements CropPlantingRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'farms.crop_plantings',
      mapper: cropPlantingMapper,
      criteria: cropPlantingCriteriaSql
    });
  }
}

export function createPgCropPlantingRepository(pool: pg.Pool): PgCropPlantingRepository {
  return new PgCropPlantingRepository(pool);
}

// ---------------------------------------------------------------------------

const HARVEST_RECORD_MAPPING = {
  id: 'id',
  planting_id: 'plantingId',
  harvested_at: 'harvestedAt',
  quantity: 'quantity',
  unit: 'unit',
  quality_grade: 'qualityGrade',
  created_at: 'createdAt'
} as const;

export const harvestRecordMapper: RowMapper<HarvestRecord> = {
  columns: Object.keys(HARVEST_RECORD_MAPPING),
  fromRow: (row) => ({
    id: row.id as string,
    plantingId: row.planting_id as string,
    harvestedAt: ts(row.harvested_at),
    quantity: num(row.quantity),
    unit: row.unit as HarvestRecord['unit'],
    qualityGrade: (row.quality_grade as HarvestRecord['qualityGrade']) ?? undefined,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) => present(item, HARVEST_RECORD_MAPPING)
};

export function harvestRecordCriteriaSql(criteria: HarvestRecordCriteria): WhereClause {
  return composeWhere(eq('planting_id', criteria.plantingId));
}

export class PgHarvestRecordRepository
  extends PgRepositoryBase<HarvestRecord, HarvestRecordCriteria>
  implements HarvestRecordRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'farms.harvest_records',
      mapper: harvestRecordMapper,
      criteria: harvestRecordCriteriaSql
    });
  }
}

export function createPgHarvestRecordRepository(pool: pg.Pool): PgHarvestRecordRepository {
  return new PgHarvestRecordRepository(pool);
}

// ---------------------------------------------------------------------------

const FARM_EXPENSE_MAPPING = {
  id: 'id',
  plot_id: 'plotId',
  category: 'category',
  amount_kobo: 'amountKobo',
  incurred_at: 'incurredAt',
  note: 'note',
  created_at: 'createdAt'
} as const;

export const farmExpenseMapper: RowMapper<FarmExpense> = {
  columns: Object.keys(FARM_EXPENSE_MAPPING),
  fromRow: (row) => ({
    id: row.id as string,
    plotId: row.plot_id as string,
    category: row.category as FarmExpense['category'],
    // bigint arrives as a string from node-pg.
    amountKobo: num(row.amount_kobo),
    incurredAt: ts(row.incurred_at),
    note: (row.note as string | null) ?? undefined,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) => present(item, FARM_EXPENSE_MAPPING)
};

export function farmExpenseCriteriaSql(criteria: FarmExpenseCriteria): WhereClause {
  return composeWhere(eq('plot_id', criteria.plotId), eq('category', criteria.category));
}

export class PgFarmExpenseRepository
  extends PgRepositoryBase<FarmExpense, FarmExpenseCriteria>
  implements FarmExpenseRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'farms.farm_expenses',
      mapper: farmExpenseMapper,
      criteria: farmExpenseCriteriaSql
    });
  }
}

export function createPgFarmExpenseRepository(pool: pg.Pool): PgFarmExpenseRepository {
  return new PgFarmExpenseRepository(pool);
}
