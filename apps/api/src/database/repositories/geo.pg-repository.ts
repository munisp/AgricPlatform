import type pg from 'pg';
import type { GeoBoundary, H3IndexEntry, H3Resolution } from '@agric-platform/shared';
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
  GeoBoundaryCriteria,
  GeoBoundaryRepository,
  H3IndexCriteria,
  H3IndexRepository
} from './geo.repository.js';

/**
 * Geospatial pack pg implementations (Wave GEO, geo schema, migration 026).
 * No PostGIS anywhere: h3_index is a plain (entity, entity_id)-keyed table
 * whose cells are computed by the application-layer H3Service (h3-js), and
 * boundaries stay JSONB. upsert uses ON CONFLICT on the composite PK so
 * reindex runs and duplicate domain-event deliveries are idempotent.
 */

const H3_INDEX_COLUMNS = [
  'entity',
  'entity_id',
  'h3_res5',
  'h3_res7',
  'h3_res9',
  'lat',
  'long',
  'updated_at'
] as const;

const H3_RESOLUTION_SQL_COLUMNS: Record<H3Resolution, string> = {
  5: 'h3_res5',
  7: 'h3_res7',
  9: 'h3_res9'
};

function h3IndexFromRow(row: Record<string, unknown>): H3IndexEntry {
  return {
    entity: row.entity as string,
    entityId: row.entity_id as string,
    h3Res5: row.h3_res5 as string,
    h3Res7: row.h3_res7 as string,
    h3Res9: row.h3_res9 as string,
    lat: num(row.lat),
    long: num(row.long),
    updatedAt: ts(row.updated_at)
  };
}

export function h3IndexCriteriaSql(criteria: H3IndexCriteria): WhereClause {
  return composeWhere(
    eq('entity', criteria.entity),
    eq('entity_id', criteria.entityId),
    eq('h3_res5', criteria.h3Res5),
    eq('h3_res7', criteria.h3Res7),
    eq('h3_res9', criteria.h3Res9)
  );
}

export class PgH3IndexRepository implements H3IndexRepository {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(entry: H3IndexEntry): Promise<H3IndexEntry> {
    await this.pool.query(
      `INSERT INTO geo.h3_index
         (entity, entity_id, h3_res5, h3_res7, h3_res9, lat, long, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (entity, entity_id) DO UPDATE SET
         h3_res5 = EXCLUDED.h3_res5,
         h3_res7 = EXCLUDED.h3_res7,
         h3_res9 = EXCLUDED.h3_res9,
         lat = EXCLUDED.lat,
         long = EXCLUDED.long,
         updated_at = EXCLUDED.updated_at`,
      [
        entry.entity,
        entry.entityId,
        entry.h3Res5,
        entry.h3Res7,
        entry.h3Res9,
        entry.lat,
        entry.long,
        entry.updatedAt
      ]
    );
    return entry;
  }

  async find(criteria: H3IndexCriteria): Promise<H3IndexEntry[]> {
    const { where, params } = h3IndexCriteriaSql(criteria);
    const result = await this.pool.query(
      `SELECT ${H3_INDEX_COLUMNS.join(', ')} FROM geo.h3_index${where} ORDER BY entity, entity_id`,
      params
    );
    return result.rows.map(h3IndexFromRow);
  }

  async findByCells(
    entity: string,
    resolution: H3Resolution,
    cells: readonly string[]
  ): Promise<H3IndexEntry[]> {
    if (cells.length === 0) {
      return [];
    }
    const column = H3_RESOLUTION_SQL_COLUMNS[resolution];
    const result = await this.pool.query(
      `SELECT ${H3_INDEX_COLUMNS.join(', ')} FROM geo.h3_index
       WHERE entity = $1 AND ${column} = ANY($2::text[])
       ORDER BY entity, entity_id`,
      [entity, [...cells]]
    );
    return result.rows.map(h3IndexFromRow);
  }

  async removeByEntity(entity: string, entityId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM geo.h3_index WHERE entity = $1 AND entity_id = $2',
      [entity, entityId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async count(criteria: H3IndexCriteria = {}): Promise<number> {
    const { where, params } = h3IndexCriteriaSql(criteria);
    const result = await this.pool.query(
      `SELECT count(*)::int AS total FROM geo.h3_index${where}`,
      params
    );
    return num(result.rows[0]?.total ?? 0);
  }
}

export function createPgH3IndexRepository(pool: pg.Pool): PgH3IndexRepository {
  return new PgH3IndexRepository(pool);
}

// ---------------------------------------------------------------------------

const GEO_BOUNDARY_MAPPING = {
  id: 'id',
  kind: 'kind',
  name: 'name',
  parent_id: 'parentId',
  boundary_geojson: 'boundaryGeojson',
  created_at: 'createdAt'
} as const;

/**
 * toRow only emits keys present on the item so Partial<T> patches update
 * exactly the patched columns (present-but-undefined → SQL NULL = clearing)
 * — same convention as the farms wave mappers.
 */
function present<T extends object>(
  item: Partial<T>,
  mapping: Record<string, keyof Partial<T>>
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [column, key] of Object.entries(mapping)) {
    if (key in item) {
      const value = (item as unknown as Record<string, unknown>)[key as string];
      row[column] = value === undefined ? null : value;
    }
  }
  return row;
}

export const geoBoundaryMapper: RowMapper<GeoBoundary> = {
  columns: Object.keys(GEO_BOUNDARY_MAPPING),
  fromRow: (row) => ({
    id: row.id as string,
    kind: row.kind as GeoBoundary['kind'],
    name: row.name as string,
    parentId: (row.parent_id as string | null) ?? undefined,
    boundaryGeojson: row.boundary_geojson,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) => present(item, GEO_BOUNDARY_MAPPING)
};

export function geoBoundaryCriteriaSql(criteria: GeoBoundaryCriteria): WhereClause {
  return composeWhere(eq('kind', criteria.kind), eq('parent_id', criteria.parentId));
}

export class PgGeoBoundaryRepository
  extends PgRepositoryBase<GeoBoundary, GeoBoundaryCriteria>
  implements GeoBoundaryRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'geo.geo_boundaries',
      mapper: geoBoundaryMapper,
      criteria: geoBoundaryCriteriaSql
    });
  }
}

export function createPgGeoBoundaryRepository(pool: pg.Pool): PgGeoBoundaryRepository {
  return new PgGeoBoundaryRepository(pool);
}
