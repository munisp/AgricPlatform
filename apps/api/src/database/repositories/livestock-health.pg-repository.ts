import { ConflictException, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type {
  AnimalHealthRecord,
  AnimalMovement,
  DiseaseFlag,
  LivestockRecall,
  MovementPermit,
  PermitSubject,
  RecallAnimal
} from '@agric-platform/shared';
import {
  composeWhere,
  eq,
  mapPgError,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import {
  diseaseFlagMapper,
  healthRecordMapper,
  movementMapper,
  movementPermitMapper,
  recallMapper
} from '../pg/row-mappers.js';
import type {
  DiseaseFlagCriteria,
  DiseaseFlagRepository,
  HealthRecordCriteria,
  HealthRecordRepository,
  MovementCriteria,
  MovementPermitCriteria,
  MovementPermitRepository,
  MovementRepository,
  RecallCriteria,
  RecallRepository
} from './livestock-health.repository.js';

/**
 * ALTP livestock health/traceability pg implementations (wave L1b, livestock
 * schema, infra/postgres/013). The health ledger is append-only — the port
 * exposes no update/remove and this class implements none.
 */

export function healthRecordCriteriaSql(criteria: HealthRecordCriteria): WhereClause {
  return composeWhere(
    eq('animal_id', criteria.animalId),
    eq('record_type', criteria.recordType),
    eq('batch_number', criteria.batchNumber),
    eq('vet_user_id', criteria.vetUserId)
  );
}

const HEALTH_RECORD_COLUMNS = healthRecordMapper.columns.join(', ');

export class PgHealthRecordRepository implements HealthRecordRepository {
  constructor(private readonly pool: pg.Pool) {}

  async all(): Promise<AnimalHealthRecord[]> {
    const result = await this.pool.query(
      `SELECT ${HEALTH_RECORD_COLUMNS} FROM livestock.health_records ORDER BY id`
    );
    return result.rows.map((row) => healthRecordMapper.fromRow(row));
  }

  async find(criteria: HealthRecordCriteria): Promise<AnimalHealthRecord[]> {
    const { where, params } = healthRecordCriteriaSql(criteria);
    const result = await this.pool.query(
      `SELECT ${HEALTH_RECORD_COLUMNS} FROM livestock.health_records${where} ORDER BY id`,
      params
    );
    return result.rows.map((row) => healthRecordMapper.fromRow(row));
  }

  async findOne(criteria: HealthRecordCriteria): Promise<AnimalHealthRecord | undefined> {
    return (await this.find(criteria))[0];
  }

  async findById(id: string): Promise<AnimalHealthRecord | undefined> {
    const result = await this.pool.query(
      `SELECT ${HEALTH_RECORD_COLUMNS} FROM livestock.health_records WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? healthRecordMapper.fromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<AnimalHealthRecord> {
    const record = await this.findById(id);
    if (!record) {
      throw new NotFoundException(`Health record with id '${id}' not found`);
    }
    return record;
  }

  /** INSERT only — the ledger is append-only by design. */
  async create(item: AnimalHealthRecord): Promise<AnimalHealthRecord> {
    const row = healthRecordMapper.toRow(item);
    const columns = Object.keys(row);
    try {
      await this.pool.query(
        `INSERT INTO livestock.health_records (${columns.join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        columns.map((column) => row[column])
      );
    } catch (error) {
      mapPgError(error);
    }
    return item;
  }

  async count(criteria?: HealthRecordCriteria): Promise<number> {
    const clause = criteria !== undefined ? healthRecordCriteriaSql(criteria) : { where: '', params: [] };
    const result = await this.pool.query(
      `SELECT count(*)::int AS n FROM livestock.health_records${clause.where}`,
      clause.params
    );
    return result.rows[0].n as number;
  }
}

export function createPgHealthRecordRepository(pool: pg.Pool): PgHealthRecordRepository {
  return new PgHealthRecordRepository(pool);
}

// ---------------------------------------------------------------------------

export function movementCriteriaSql(criteria: MovementCriteria): WhereClause {
  return composeWhere(
    eq('animal_id', criteria.animalId),
    eq('lot_id', criteria.lotId),
    eq('permit_id', criteria.permitId),
    criteria.open === undefined
      ? null
      : { where: criteria.open ? 'arrived_at IS NULL' : 'arrived_at IS NOT NULL', params: [] }
  );
}

export class PgMovementRepository
  extends PgRepositoryBase<AnimalMovement, MovementCriteria>
  implements MovementRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.movements',
      mapper: movementMapper,
      criteria: movementCriteriaSql
    });
  }
}

export function createPgMovementRepository(pool: pg.Pool): PgMovementRepository {
  return new PgMovementRepository(pool);
}

// ---------------------------------------------------------------------------

export function movementPermitCriteriaSql(criteria: MovementPermitCriteria): WhereClause {
  return composeWhere(
    eq('status', criteria.status),
    eq('from_state', criteria.fromState),
    eq('to_state', criteria.toState)
  );
}

export class PgMovementPermitRepository
  extends PgRepositoryBase<MovementPermit, MovementPermitCriteria>
  implements MovementPermitRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.movement_permits',
      mapper: movementPermitMapper,
      criteria: movementPermitCriteriaSql
    });
  }

  async findByPermitNumber(permitNumber: string): Promise<MovementPermit | undefined> {
    const result = await this.pool.query(
      `SELECT ${movementPermitMapper.columns.join(', ')} FROM livestock.movement_permits
       WHERE permit_number = $1`,
      [permitNumber]
    );
    return result.rows[0] ? movementPermitMapper.fromRow(result.rows[0]) : undefined;
  }

  override async create(item: MovementPermit): Promise<MovementPermit> {
    try {
      return await super.create(item);
    } catch (error) {
      if (error instanceof ConflictException) {
        throw new ConflictException(`Permit number '${item.permitNumber}' is already issued`);
      }
      throw error;
    }
  }

  async addSubject(subject: PermitSubject): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO livestock.movement_permit_subjects (permit_id, subject_type, subject_id)
         VALUES ($1, $2, $3)`,
        [subject.permitId, subject.subjectType, subject.subjectId]
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505') {
        throw new ConflictException(
          `${subject.subjectType} '${subject.subjectId}' is already on permit '${subject.permitId}'`
        );
      }
      mapPgError(error);
    }
  }

  async listSubjects(permitId: string): Promise<PermitSubject[]> {
    const result = await this.pool.query(
      `SELECT permit_id, subject_type, subject_id FROM livestock.movement_permit_subjects
       WHERE permit_id = $1 ORDER BY subject_type, subject_id`,
      [permitId]
    );
    return result.rows.map((row) => ({
      permitId: row.permit_id as string,
      subjectType: row.subject_type as PermitSubject['subjectType'],
      subjectId: row.subject_id as string
    }));
  }
}

export function createPgMovementPermitRepository(pool: pg.Pool): PgMovementPermitRepository {
  return new PgMovementPermitRepository(pool);
}

// ---------------------------------------------------------------------------

export function recallCriteriaSql(criteria: RecallCriteria): WhereClause {
  return composeWhere(
    eq('status', criteria.status),
    eq('scope', criteria.scope),
    eq('state', criteria.state),
    eq('initiated_by', criteria.initiatedBy)
  );
}

export class PgRecallRepository
  extends PgRepositoryBase<LivestockRecall, RecallCriteria>
  implements RecallRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.recalls',
      mapper: recallMapper,
      criteria: recallCriteriaSql
    });
  }

  async addAnimal(entry: RecallAnimal): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO livestock.recall_animals (recall_id, animal_id, owner_user_id)
         VALUES ($1, $2, $3)`,
        [entry.recallId, entry.animalId, entry.ownerUserId]
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505') {
        throw new ConflictException(
          `Animal '${entry.animalId}' is already in recall '${entry.recallId}'`
        );
      }
      mapPgError(error);
    }
  }

  async listAnimals(recallId: string): Promise<RecallAnimal[]> {
    const result = await this.pool.query(
      `SELECT recall_id, animal_id, owner_user_id FROM livestock.recall_animals
       WHERE recall_id = $1 ORDER BY added_at, animal_id`,
      [recallId]
    );
    return result.rows.map((row) => ({
      recallId: row.recall_id as string,
      animalId: row.animal_id as string,
      ownerUserId: row.owner_user_id as string
    }));
  }
}

export function createPgRecallRepository(pool: pg.Pool): PgRecallRepository {
  return new PgRecallRepository(pool);
}

// ---------------------------------------------------------------------------

export function diseaseFlagCriteriaSql(criteria: DiseaseFlagCriteria): WhereClause {
  return composeWhere(
    eq('status', criteria.status),
    eq('state', criteria.state),
    eq('disease', criteria.disease),
    eq('reporter_user_id', criteria.reporterUserId)
  );
}

export class PgDiseaseFlagRepository
  extends PgRepositoryBase<DiseaseFlag, DiseaseFlagCriteria>
  implements DiseaseFlagRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.disease_flags',
      mapper: diseaseFlagMapper,
      criteria: diseaseFlagCriteriaSql
    });
  }
}

export function createPgDiseaseFlagRepository(pool: pg.Pool): PgDiseaseFlagRepository {
  return new PgDiseaseFlagRepository(pool);
}
