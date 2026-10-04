import type pg from 'pg';
import type {
  Animal,
  Herd,
  HerdEntry,
  HerdExit,
  PastoralistProfile
} from '@agric-platform/shared';
import {
  composeWhere,
  eq,
  PgRepositoryBase,
  type RowMapper,
  type WhereClause
} from '../pg/pg-repository.base.js';
import type {
  HerdCriteria,
  HerdEntryCriteria,
  HerdEntryRepository,
  HerdExitCriteria,
  HerdExitRepository,
  HerdRepository,
  PastoralistProfileRepository
} from './herds.repository.js';
import type { AnimalCriteria, LivestockAnimalRepository } from './livestock.repository.js';

/**
 * Livestock pg implementations (livestock schema, migrations 025 + 041
 * herds pack). PK columns are plain `id`, so the base id-keyed methods
 * apply unchanged; mappers are local to keep the livestock wave
 * self-contained. toRow only emits keys present on the item so Partial<T>
 * patches update exactly the patched columns (present-but-undefined →
 * SQL NULL = clearing; matches farms wave).
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

// ---------------------------------------------------------------------------
// livestock.animals
// ---------------------------------------------------------------------------

const ANIMAL_MAPPING = {
  id: 'id',
  owner_user_id: 'ownerUserId',
  species: 'species',
  breed: 'breed',
  sex: 'sex',
  birth_date: 'birthDate',
  acquisition: 'acquisition',
  tag_id: 'tagId',
  photo_ref: 'photoRef',
  status: 'status',
  state: 'state',
  lga: 'lga',
  herd_id: 'herdId',
  created_at: 'createdAt',
  updated_at: 'updatedAt'
} as const;

export const animalMapper: RowMapper<Animal> = {
  columns: Object.keys(ANIMAL_MAPPING),
  fromRow: (row) => ({
    id: row.id as string,
    ownerUserId: row.owner_user_id as string,
    species: row.species as Animal['species'],
    breed: row.breed as string,
    sex: row.sex as Animal['sex'],
    birthDate: row.birth_date ? new Date(row.birth_date as string).toISOString() : undefined,
    acquisition: (row.acquisition as Animal['acquisition']) ?? undefined,
    tagId: (row.tag_id as string | null) ?? undefined,
    photoRef: (row.photo_ref as string | null) ?? undefined,
    status: row.status as Animal['status'],
    state: row.state as string,
    lga: row.lga as string,
    herdId: (row.herd_id as string | null) ?? undefined,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString()
  }),
  toRow: (item) => present(item, ANIMAL_MAPPING)
};

export function animalCriteriaSql(criteria: AnimalCriteria): WhereClause {
  const clauses: WhereClause[] = [
    eq('owner_user_id', criteria.ownerUserId),
    eq('species', criteria.species),
    eq('status', criteria.status),
    eq('state', criteria.state)
  ];
  if (criteria.q) {
    const needle = `%${criteria.q.toLowerCase()}%`;
    clauses.push({
      sql: '(lower(id) LIKE ? OR lower(breed) LIKE ? OR lower(COALESCE(tag_id, \'\')) LIKE ?)',
      params: [needle, needle, needle]
    });
  }
  return composeWhere(...clauses);
}

export class PgAnimalRepository
  extends PgRepositoryBase<Animal, AnimalCriteria>
  implements LivestockAnimalRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.animals',
      mapper: animalMapper,
      criteria: animalCriteriaSql
    });
  }

  async countByOwner(ownerUserId: string): Promise<number> {
    return this.count({ ownerUserId });
  }

  async countBySpecies(): Promise<Partial<Record<Animal['species'], number>>> {
    const result = await this.pool.query(
      'SELECT species, count(*)::int AS n FROM livestock.animals GROUP BY species'
    );
    const counts: Partial<Record<Animal['species'], number>> = {};
    for (const row of result.rows) {
      counts[row.species as Animal['species']] = Number(row.n);
    }
    return counts;
  }

  /** CAS status transition: 0 rows = the animal moved concurrently (GAP-M16). */
  async transitionStatus(
    id: string,
    from: Animal['status'],
    to: Animal['status']
  ): Promise<Animal | undefined> {
    const result = await this.pool.query(
      `UPDATE livestock.animals
         SET status = $2, updated_at = now()
       WHERE id = $1 AND status = $3
       RETURNING ${animalMapper.columns.join(', ')}`,
      [id, to, from]
    );
    return result.rows[0] ? animalMapper.fromRow(result.rows[0]) : undefined;
  }
}

export function createPgAnimalRepository(pool: pg.Pool): PgAnimalRepository {
  return new PgAnimalRepository(pool);
}

// ---------------------------------------------------------------------------
// livestock.herds
// ---------------------------------------------------------------------------

const HERD_MAPPING = {
  id: 'id',
  owner_user_id: 'ownerUserId',
  name: 'name',
  state: 'state',
  lga: 'lga',
  grazing_area: 'grazingArea',
  notes: 'notes',
  created_at: 'createdAt',
  updated_at: 'updatedAt'
} as const;

export const herdMapper: RowMapper<Herd> = {
  columns: Object.keys(HERD_MAPPING),
  fromRow: (row) => ({
    id: row.id as string,
    ownerUserId: row.owner_user_id as string,
    name: row.name as string,
    state: row.state as string,
    lga: row.lga as string,
    grazingArea: (row.grazing_area as string | null) ?? undefined,
    notes: (row.notes as string | null) ?? undefined,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString()
  }),
  toRow: (item) => present(item, HERD_MAPPING)
};

export function herdCriteriaSql(criteria: HerdCriteria): WhereClause {
  return composeWhere(eq('owner_user_id', criteria.ownerUserId), eq('state', criteria.state));
}

export class PgHerdRepository extends PgRepositoryBase<Herd, HerdCriteria> implements HerdRepository {
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.herds',
      mapper: herdMapper,
      criteria: herdCriteriaSql
    });
  }
}

export function createPgHerdRepository(pool: pg.Pool): PgHerdRepository {
  return new PgHerdRepository(pool);
}

// ---------------------------------------------------------------------------
// livestock.herd_entries
// ---------------------------------------------------------------------------

const HERD_ENTRY_MAPPING = {
  id: 'id',
  herd_id: 'herdId',
  animal_id: 'animalId',
  entered_at: 'enteredAt',
  note: 'note'
} as const;

export const herdEntryMapper: RowMapper<HerdEntry> = {
  columns: Object.keys(HERD_ENTRY_MAPPING),
  fromRow: (row) => ({
    id: row.id as string,
    herdId: row.herd_id as string,
    animalId: row.animal_id as string,
    enteredAt: new Date(row.entered_at as string).toISOString(),
    note: (row.note as string | null) ?? undefined
  }),
  toRow: (item) => present(item, HERD_ENTRY_MAPPING)
};

export function herdEntryCriteriaSql(criteria: HerdEntryCriteria): WhereClause {
  return composeWhere(eq('herd_id', criteria.herdId), eq('animal_id', criteria.animalId));
}

export class PgHerdEntryRepository
  extends PgRepositoryBase<HerdEntry, HerdEntryCriteria>
  implements HerdEntryRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.herd_entries',
      mapper: herdEntryMapper,
      criteria: herdEntryCriteriaSql,
      orderBy: 'entered_at'
    });
  }
}

export function createPgHerdEntryRepository(pool: pg.Pool): PgHerdEntryRepository {
  return new PgHerdEntryRepository(pool);
}

// ---------------------------------------------------------------------------
// livestock.herd_exits
// ---------------------------------------------------------------------------

const HERD_EXIT_MAPPING = {
  id: 'id',
  herd_id: 'herdId',
  animal_id: 'animalId',
  exited_at: 'exitedAt',
  note: 'note'
} as const;

export const herdExitMapper: RowMapper<HerdExit> = {
  columns: Object.keys(HERD_EXIT_MAPPING),
  fromRow: (row) => ({
    id: row.id as string,
    herdId: row.herd_id as string,
    animalId: row.animal_id as string,
    exitedAt: new Date(row.exited_at as string).toISOString(),
    note: (row.note as string | null) ?? undefined
  }),
  toRow: (item) => present(item, HERD_EXIT_MAPPING)
};

export function herdExitCriteriaSql(criteria: HerdExitCriteria): WhereClause {
  return composeWhere(eq('herd_id', criteria.herdId), eq('animal_id', criteria.animalId));
}

export class PgHerdExitRepository
  extends PgRepositoryBase<HerdExit, HerdExitCriteria>
  implements HerdExitRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.herd_exits',
      mapper: herdExitMapper,
      criteria: herdExitCriteriaSql,
      orderBy: 'exited_at'
    });
  }
}

export function createPgHerdExitRepository(pool: pg.Pool): PgHerdExitRepository {
  return new PgHerdExitRepository(pool);
}

// ---------------------------------------------------------------------------
// livestock.pastoralist_profiles (one per user, keyed by user_id)
// ---------------------------------------------------------------------------

const PASTORALIST_PROFILE_MAPPING = {
  id: 'id',
  user_id: 'userId',
  herd_size: 'herdSize',
  primary_species: 'primarySpecies',
  migration_corridor: 'migrationCorridor',
  state: 'state',
  lga: 'lga',
  updated_at: 'updatedAt'
} as const;

export const pastoralistProfileMapper: RowMapper<PastoralistProfile> = {
  columns: Object.keys(PASTORALIST_PROFILE_MAPPING),
  fromRow: (row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    herdSize: Number(row.herd_size),
    primarySpecies: row.primary_species as PastoralistProfile['primarySpecies'],
    migrationCorridor: (row.migration_corridor as string | null) ?? undefined,
    state: row.state as string,
    lga: row.lga as string,
    updatedAt: new Date(row.updated_at as string).toISOString()
  }),
  toRow: (item) => present(item, PASTORALIST_PROFILE_MAPPING)
};

export class PgPastoralistProfileRepository implements PastoralistProfileRepository {
  constructor(private readonly pool: pg.Pool) {}

  async forUser(userId: string): Promise<PastoralistProfile | undefined> {
    const result = await this.pool.query(
      `SELECT ${pastoralistProfileMapper.columns.join(', ')} FROM livestock.pastoralist_profiles WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0] ? pastoralistProfileMapper.fromRow(result.rows[0]) : undefined;
  }

  /** One profile per user: upsert keyed on user_id. */
  async upsert(profile: PastoralistProfile): Promise<PastoralistProfile> {
    const result = await this.pool.query(
      `INSERT INTO livestock.pastoralist_profiles (id, user_id, herd_size, primary_species, migration_corridor, state, lga, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id) DO UPDATE SET
         herd_size = EXCLUDED.herd_size,
         primary_species = EXCLUDED.primary_species,
         migration_corridor = EXCLUDED.migration_corridor,
         state = EXCLUDED.state,
         lga = EXCLUDED.lga,
         updated_at = EXCLUDED.updated_at
       RETURNING ${pastoralistProfileMapper.columns.join(', ')}`,
      [
        profile.id,
        profile.userId,
        profile.herdSize,
        profile.primarySpecies,
        profile.migrationCorridor ?? null,
        profile.state,
        profile.lga,
        profile.updatedAt
      ]
    );
    return pastoralistProfileMapper.fromRow(result.rows[0]);
  }
}

export function createPgPastoralistProfileRepository(
  pool: pg.Pool
): PgPastoralistProfileRepository {
  return new PgPastoralistProfileRepository(pool);
}
