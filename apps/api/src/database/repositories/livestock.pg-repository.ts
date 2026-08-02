import { ConflictException, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type {
  Animal,
  LivestockLot,
  LivestockSpecies,
  OwnershipTransfer,
  PastoralistProfile
} from '@agric-platform/shared';
import {
  composeWhere,
  eq,
  mapPgError,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import {
  animalMapper,
  lotMapper,
  ownershipTransferMapper,
  pastoralistProfileMapper
} from '../pg/row-mappers.js';
import type {
  AnimalCriteria,
  AnimalRepository,
  LotCriteria,
  LotRepository,
  OwnershipTransferCriteria,
  OwnershipTransferRepository,
  PastoralistProfileRepository
} from './livestock.repository.js';

/**
 * ALTP livestock pg implementations (wave L1a, livestock schema). The PK
 * columns are domain-named (animal_id / lot_id), so the id-keyed base
 * methods are overridden.
 */

const ANIMAL_COLUMNS = animalMapper.columns.join(', ');

export function animalCriteriaSql(criteria: AnimalCriteria): WhereClause {
  return composeWhere(
    eq('owner_user_id', criteria.ownerUserId),
    eq('species', criteria.species),
    eq('status', criteria.status),
    eq('state', criteria.state),
    eq('tag_id', criteria.tagId)
  );
}

export class PgAnimalRepository
  extends PgRepositoryBase<Animal, AnimalCriteria>
  implements AnimalRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.animals',
      mapper: animalMapper,
      criteria: animalCriteriaSql,
      orderBy: 'animal_id'
    });
  }

  override async findById(id: string): Promise<Animal | undefined> {
    const result = await this.pool.query(
      `SELECT ${ANIMAL_COLUMNS} FROM livestock.animals WHERE animal_id = $1`,
      [id]
    );
    return result.rows[0] ? animalMapper.fromRow(result.rows[0]) : undefined;
  }

  override async getById(id: string): Promise<Animal> {
    const animal = await this.findById(id);
    if (!animal) {
      throw new NotFoundException(`Animal with id '${id}' not found`);
    }
    return animal;
  }

  override async update(id: string, patch: Partial<Animal>): Promise<Animal> {
    const row = animalMapper.toRow(patch as Animal);
    const columns = Object.keys(row).filter((column) => column !== 'animal_id');
    if (columns.length === 0) {
      return this.getById(id);
    }
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
    const values = columns.map((column) => row[column]);
    const result = await this.pool.query(
      `UPDATE livestock.animals SET ${assignments} WHERE animal_id = $1 RETURNING ${ANIMAL_COLUMNS}`,
      [id, ...values]
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Animal with id '${id}' not found`);
    }
    return animalMapper.fromRow(result.rows[0]);
  }

  override async remove(id: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM livestock.animals WHERE animal_id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Atomic serial issuance: one upsert returning the incremented counter. */
  async nextSerial(species: LivestockSpecies, state: string): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO livestock.animal_serials (species, state, next_serial)
       VALUES ($1, $2, 2)
       ON CONFLICT (species, state) DO UPDATE
         SET next_serial = livestock.animal_serials.next_serial + 1
       RETURNING next_serial`,
      [species, state]
    );
    return (result.rows[0].next_serial as number) - 1;
  }

  async findByTagId(tagId: string): Promise<Animal | undefined> {
    return this.findOne({ tagId });
  }

  override async create(item: Animal): Promise<Animal> {
    try {
      return await super.create(item);
    } catch (error) {
      if (error instanceof ConflictException && item.tagId) {
        throw new ConflictException(`Tag id '${item.tagId}' is already registered`);
      }
      throw error;
    }
  }

  /** Ledger insert + owner update in a single transaction. */
  async transferOwnership(transfer: OwnershipTransfer): Promise<void> {
    await this.withTransaction(async (client) => {
      const row = ownershipTransferMapper.toRow(transfer);
      const columns = Object.keys(row);
      try {
        await client.query(
          `INSERT INTO livestock.ownership_transfers (${columns.join(', ')})
           VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
          columns.map((column) => row[column])
        );
      } catch (error) {
        mapPgError(error);
      }
      const updated = await client.query(
        `UPDATE livestock.animals SET owner_user_id = $2, updated_at = $3
         WHERE animal_id = $1`,
        [transfer.animalId, transfer.toUserId, transfer.createdAt]
      );
      if ((updated.rowCount ?? 0) === 0) {
        throw new NotFoundException(`Animal with id '${transfer.animalId}' not found`);
      }
    });
  }
}

export function createPgAnimalRepository(pool: pg.Pool): PgAnimalRepository {
  return new PgAnimalRepository(pool);
}

// ---------------------------------------------------------------------------

export function ownershipTransferCriteriaSql(criteria: OwnershipTransferCriteria): WhereClause {
  return composeWhere(
    eq('animal_id', criteria.animalId),
    eq('from_user_id', criteria.fromUserId),
    eq('to_user_id', criteria.toUserId)
  );
}

export class PgOwnershipTransferRepository
  extends PgRepositoryBase<OwnershipTransfer, OwnershipTransferCriteria>
  implements OwnershipTransferRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.ownership_transfers',
      mapper: ownershipTransferMapper,
      criteria: ownershipTransferCriteriaSql
    });
  }
}

export function createPgOwnershipTransferRepository(pool: pg.Pool): PgOwnershipTransferRepository {
  return new PgOwnershipTransferRepository(pool);
}

// ---------------------------------------------------------------------------

const LOT_COLUMNS = lotMapper.columns.join(', ');

export function lotCriteriaSql(criteria: LotCriteria): WhereClause {
  return composeWhere(
    eq('owner_user_id', criteria.ownerUserId),
    eq('species', criteria.species),
    eq('status', criteria.status),
    eq('state', criteria.state)
  );
}

export class PgLotRepository
  extends PgRepositoryBase<LivestockLot, LotCriteria>
  implements LotRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.lots',
      mapper: lotMapper,
      criteria: lotCriteriaSql,
      orderBy: 'lot_id'
    });
  }

  override async findById(id: string): Promise<LivestockLot | undefined> {
    const result = await this.pool.query(
      `SELECT ${LOT_COLUMNS} FROM livestock.lots WHERE lot_id = $1`,
      [id]
    );
    return result.rows[0] ? lotMapper.fromRow(result.rows[0]) : undefined;
  }

  override async getById(id: string): Promise<LivestockLot> {
    const lot = await this.findById(id);
    if (!lot) {
      throw new NotFoundException(`Lot with id '${id}' not found`);
    }
    return lot;
  }

  override async update(id: string, patch: Partial<LivestockLot>): Promise<LivestockLot> {
    const row = lotMapper.toRow(patch as LivestockLot);
    const columns = Object.keys(row).filter((column) => column !== 'lot_id');
    if (columns.length === 0) {
      return this.getById(id);
    }
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
    const values = columns.map((column) => row[column]);
    const result = await this.pool.query(
      `UPDATE livestock.lots SET ${assignments} WHERE lot_id = $1 RETURNING ${LOT_COLUMNS}`,
      [id, ...values]
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Lot with id '${id}' not found`);
    }
    return lotMapper.fromRow(result.rows[0]);
  }

  override async remove(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM livestock.lots WHERE lot_id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Lot serials share livestock.animal_serials under a 'lot:' species prefix
   * so issuance stays atomic without a second counter table.
   */
  async nextLotSerial(species: LivestockSpecies, state: string): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO livestock.animal_serials (species, state, next_serial)
       VALUES ($1, $2, 2)
       ON CONFLICT (species, state) DO UPDATE
         SET next_serial = livestock.animal_serials.next_serial + 1
       RETURNING next_serial`,
      [`lot:${species}`, state]
    );
    return (result.rows[0].next_serial as number) - 1;
  }

  async addAnimal(lotId: string, animalId: string): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO livestock.lot_animals (lot_id, animal_id) VALUES ($1, $2)',
        [lotId, animalId]
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505') {
        throw new ConflictException(`Animal '${animalId}' is already in lot '${lotId}'`);
      }
      mapPgError(error);
    }
  }

  async removeAnimal(lotId: string, animalId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM livestock.lot_animals WHERE lot_id = $1 AND animal_id = $2',
      [lotId, animalId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listAnimalIds(lotId: string): Promise<string[]> {
    const result = await this.pool.query(
      'SELECT animal_id FROM livestock.lot_animals WHERE lot_id = $1 ORDER BY added_at, animal_id',
      [lotId]
    );
    return result.rows.map((row) => row.animal_id as string);
  }
}

export function createPgLotRepository(pool: pg.Pool): PgLotRepository {
  return new PgLotRepository(pool);
}

// ---------------------------------------------------------------------------

const PASTORALIST_COLUMNS = pastoralistProfileMapper.columns.join(', ');

/** Pastoralist profile over livestock.pastoralist_profiles, keyed by user_id. */
export class PgPastoralistProfileRepository implements PastoralistProfileRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findByUserId(userId: string): Promise<PastoralistProfile | undefined> {
    const result = await this.pool.query(
      `SELECT ${PASTORALIST_COLUMNS} FROM livestock.pastoralist_profiles WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0] ? pastoralistProfileMapper.fromRow(result.rows[0]) : undefined;
  }

  async upsert(profile: PastoralistProfile): Promise<PastoralistProfile> {
    const row = pastoralistProfileMapper.toRow(profile);
    const columns = Object.keys(row);
    const assignments = columns
      .filter((column) => column !== 'user_id')
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(', ');
    await this.pool.query(
      `INSERT INTO livestock.pastoralist_profiles (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (user_id) DO UPDATE SET ${assignments}`,
      columns.map((column) => row[column])
    );
    return profile;
  }
}

export function createPgPastoralistProfileRepository(pool: pg.Pool): PgPastoralistProfileRepository {
  return new PgPastoralistProfileRepository(pool);
}
