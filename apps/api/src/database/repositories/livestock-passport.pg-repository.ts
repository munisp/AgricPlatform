import type pg from 'pg';
import { NotFoundException } from '@nestjs/common';
import type {
  LivestockPassport,
  PassportEvent,
  PassportTransfer
} from '../../modules/livestock-passport/passport.types.js';
import { mapPgError } from '../pg/pg-repository.base.js';
import type {
  LivestockPassportCriteria,
  LivestockPassportRepository,
  PassportEventRepository,
  PassportTransferCriteria,
  PassportTransferRepository
} from './livestock-passport.repository.js';

/**
 * Digital livestock passport pg implementations (wave-livestock-passport,
 * schema `livestock_passport`, migration 036). Passport events expose NO
 * update or delete statements at all — append-only is enforced by the
 * absence of a write path here, with the hash chain as the tamper-evidence
 * layer. jsonb columns are serialised explicitly.
 */

function str(row: Record<string, unknown>, column: string): string {
  return row[column] as string;
}

function num(row: Record<string, unknown>, column: string): number {
  return Number(row[column]);
}

function ts(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  return value instanceof Date ? value.toISOString() : String(value);
}

function tsOrUndef(row: Record<string, unknown>, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : String(value);
}

function strOrUndef(row: Record<string, unknown>, column: string): string | undefined {
  return (row[column] as string | null) ?? undefined;
}

/* ------------------------------- passports ------------------------------- */

const PASSPORT_COLS =
  'id, animal_id, passport_code, code_nonce, code_signature, owner_user_id, status, tag_check_basis, tag_check_detail, issued_by, created_at, updated_at';

function passportFromRow(row: Record<string, unknown>): LivestockPassport {
  return {
    id: str(row, 'id'),
    animalId: str(row, 'animal_id'),
    passportCode: str(row, 'passport_code'),
    codeNonce: str(row, 'code_nonce'),
    codeSignature: str(row, 'code_signature'),
    ownerUserId: str(row, 'owner_user_id'),
    status: str(row, 'status') as LivestockPassport['status'],
    tagCheckBasis: str(row, 'tag_check_basis') as LivestockPassport['tagCheckBasis'],
    tagCheckDetail: strOrUndef(row, 'tag_check_detail'),
    issuedBy: str(row, 'issued_by'),
    createdAt: ts(row, 'created_at'),
    updatedAt: ts(row, 'updated_at')
  };
}

export class PgLivestockPassportRepository implements LivestockPassportRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(passport: LivestockPassport): Promise<LivestockPassport> {
    try {
      await this.pool.query(
        `INSERT INTO livestock_passport.passports (${PASSPORT_COLS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          passport.id,
          passport.animalId,
          passport.passportCode,
          passport.codeNonce,
          passport.codeSignature,
          passport.ownerUserId,
          passport.status,
          passport.tagCheckBasis,
          passport.tagCheckDetail ?? null,
          passport.issuedBy,
          passport.createdAt,
          passport.updatedAt
        ]
      );
      return passport;
    } catch (error) {
      mapPgError(error);
    }
  }

  async findById(id: string): Promise<LivestockPassport | undefined> {
    const result = await this.pool.query(
      `SELECT ${PASSPORT_COLS} FROM livestock_passport.passports WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? passportFromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<LivestockPassport> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`Livestock passport '${id}' not found`);
    }
    return item;
  }

  async findByCode(passportCode: string): Promise<LivestockPassport | undefined> {
    const result = await this.pool.query(
      `SELECT ${PASSPORT_COLS} FROM livestock_passport.passports WHERE passport_code = $1`,
      [passportCode]
    );
    return result.rows[0] ? passportFromRow(result.rows[0]) : undefined;
  }

  async findByAnimalId(animalId: string): Promise<LivestockPassport | undefined> {
    const result = await this.pool.query(
      `SELECT ${PASSPORT_COLS} FROM livestock_passport.passports WHERE animal_id = $1`,
      [animalId]
    );
    return result.rows[0] ? passportFromRow(result.rows[0]) : undefined;
  }

  async find(criteria: LivestockPassportCriteria): Promise<LivestockPassport[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (criteria.ownerUserId) {
      values.push(criteria.ownerUserId);
      where.push(`owner_user_id = $${values.length}`);
    }
    if (criteria.animalId) {
      values.push(criteria.animalId);
      where.push(`animal_id = $${values.length}`);
    }
    if (criteria.status) {
      values.push(criteria.status);
      where.push(`status = $${values.length}`);
    }
    const result = await this.pool.query(
      `SELECT ${PASSPORT_COLS} FROM livestock_passport.passports${
        where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
      } ORDER BY created_at ASC`,
      values
    );
    return result.rows.map(passportFromRow);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        LivestockPassport,
        'status' | 'ownerUserId' | 'tagCheckBasis' | 'tagCheckDetail' | 'updatedAt'
      >
    >
  ): Promise<LivestockPassport> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const columnByField = {
      status: 'status',
      ownerUserId: 'owner_user_id',
      tagCheckBasis: 'tag_check_basis',
      tagCheckDetail: 'tag_check_detail',
      updatedAt: 'updated_at'
    } as const;
    for (const field of Object.keys(columnByField) as Array<keyof typeof columnByField>) {
      if (patch[field] !== undefined) {
        values.push(patch[field]);
        assignments.push(`${columnByField[field]} = $${values.length}`);
      }
    }
    if (assignments.length === 0) {
      return this.getById(id);
    }
    values.push(id);
    const result = await this.pool.query(
      `UPDATE livestock_passport.passports SET ${assignments.join(', ')}
       WHERE id = $${values.length} RETURNING ${PASSPORT_COLS}`,
      values
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Livestock passport '${id}' not found`);
    }
    return passportFromRow(result.rows[0]);
  }
}

export function createPgLivestockPassportRepository(pool: pg.Pool): PgLivestockPassportRepository {
  return new PgLivestockPassportRepository(pool);
}

/* ---------------------------- passport events ----------------------------- */

const EVENT_COLS =
  'id, passport_id, seq, type, actor_id, payload, prev_event_hash, event_hash, created_at';

function eventFromRow(row: Record<string, unknown>): PassportEvent {
  const payload = row['payload'];
  return {
    id: str(row, 'id'),
    passportId: str(row, 'passport_id'),
    seq: num(row, 'seq'),
    type: str(row, 'type') as PassportEvent['type'],
    actorId: str(row, 'actor_id'),
    payload:
      typeof payload === 'string'
        ? (JSON.parse(payload) as Record<string, unknown>)
        : ((payload ?? {}) as Record<string, unknown>),
    prevEventHash: str(row, 'prev_event_hash'),
    eventHash: str(row, 'event_hash'),
    createdAt: ts(row, 'created_at')
  };
}

/** Append-only: deliberately no UPDATE/DELETE for passport_events. */
export class PgPassportEventRepository implements PassportEventRepository {
  constructor(private readonly pool: pg.Pool) {}

  async append(event: PassportEvent): Promise<PassportEvent> {
    try {
      await this.pool.query(
        `INSERT INTO livestock_passport.passport_events (${EVENT_COLS})
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
        [
          event.id,
          event.passportId,
          event.seq,
          event.type,
          event.actorId,
          JSON.stringify(event.payload ?? {}),
          event.prevEventHash,
          event.eventHash,
          event.createdAt
        ]
      );
      return event;
    } catch (error) {
      // Unique violations (event_hash or (passport_id, seq)) mean a rewritten
      // history collided with the stored chain — surface as a conflict.
      mapPgError(error);
    }
  }

  async findById(id: string): Promise<PassportEvent | undefined> {
    const result = await this.pool.query(
      `SELECT ${EVENT_COLS} FROM livestock_passport.passport_events WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? eventFromRow(result.rows[0]) : undefined;
  }

  async listByPassport(passportId: string): Promise<PassportEvent[]> {
    const result = await this.pool.query(
      `SELECT ${EVENT_COLS} FROM livestock_passport.passport_events
       WHERE passport_id = $1 ORDER BY seq ASC`,
      [passportId]
    );
    return result.rows.map(eventFromRow);
  }

  async countByPassport(passportId: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT COUNT(*) AS count FROM livestock_passport.passport_events WHERE passport_id = $1',
      [passportId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}

export function createPgPassportEventRepository(pool: pg.Pool): PgPassportEventRepository {
  return new PgPassportEventRepository(pool);
}

/* --------------------------- passport transfers --------------------------- */

const TRANSFER_COLS =
  'id, passport_id, animal_id, from_user_id, to_user_id, status, note, executed_transfer_id, initiated_at, confirmed_at, cancelled_at, created_at, updated_at';

function transferFromRow(row: Record<string, unknown>): PassportTransfer {
  return {
    id: str(row, 'id'),
    passportId: str(row, 'passport_id'),
    animalId: str(row, 'animal_id'),
    fromUserId: str(row, 'from_user_id'),
    toUserId: str(row, 'to_user_id'),
    status: str(row, 'status') as PassportTransfer['status'],
    note: strOrUndef(row, 'note'),
    executedTransferId: strOrUndef(row, 'executed_transfer_id'),
    initiatedAt: ts(row, 'initiated_at'),
    confirmedAt: tsOrUndef(row, 'confirmed_at'),
    cancelledAt: tsOrUndef(row, 'cancelled_at'),
    createdAt: ts(row, 'created_at'),
    updatedAt: ts(row, 'updated_at')
  };
}

export class PgPassportTransferRepository implements PassportTransferRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(transfer: PassportTransfer): Promise<PassportTransfer> {
    try {
      await this.pool.query(
        `INSERT INTO livestock_passport.passport_transfers (${TRANSFER_COLS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          transfer.id,
          transfer.passportId,
          transfer.animalId,
          transfer.fromUserId,
          transfer.toUserId,
          transfer.status,
          transfer.note ?? null,
          transfer.executedTransferId ?? null,
          transfer.initiatedAt,
          transfer.confirmedAt ?? null,
          transfer.cancelledAt ?? null,
          transfer.createdAt,
          transfer.updatedAt
        ]
      );
      return transfer;
    } catch (error) {
      // The partial unique index (one pending transfer per passport)
      // surfaces here as a 409.
      mapPgError(error);
    }
  }

  async findById(id: string): Promise<PassportTransfer | undefined> {
    const result = await this.pool.query(
      `SELECT ${TRANSFER_COLS} FROM livestock_passport.passport_transfers WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? transferFromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<PassportTransfer> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`Passport transfer '${id}' not found`);
    }
    return item;
  }

  async find(criteria: PassportTransferCriteria): Promise<PassportTransfer[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (criteria.passportId) {
      values.push(criteria.passportId);
      where.push(`passport_id = $${values.length}`);
    }
    if (criteria.fromUserId) {
      values.push(criteria.fromUserId);
      where.push(`from_user_id = $${values.length}`);
    }
    if (criteria.toUserId) {
      values.push(criteria.toUserId);
      where.push(`to_user_id = $${values.length}`);
    }
    if (criteria.status) {
      values.push(criteria.status);
      where.push(`status = $${values.length}`);
    }
    const result = await this.pool.query(
      `SELECT ${TRANSFER_COLS} FROM livestock_passport.passport_transfers${
        where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
      } ORDER BY created_at ASC`,
      values
    );
    return result.rows.map(transferFromRow);
  }

  async findPendingForPassport(passportId: string): Promise<PassportTransfer | undefined> {
    const result = await this.pool.query(
      `SELECT ${TRANSFER_COLS} FROM livestock_passport.passport_transfers
       WHERE passport_id = $1 AND status = 'pending'`,
      [passportId]
    );
    return result.rows[0] ? transferFromRow(result.rows[0]) : undefined;
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        PassportTransfer,
        'status' | 'executedTransferId' | 'confirmedAt' | 'cancelledAt' | 'updatedAt'
      >
    >
  ): Promise<PassportTransfer> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const columnByField = {
      status: 'status',
      executedTransferId: 'executed_transfer_id',
      confirmedAt: 'confirmed_at',
      cancelledAt: 'cancelled_at',
      updatedAt: 'updated_at'
    } as const;
    for (const field of Object.keys(columnByField) as Array<keyof typeof columnByField>) {
      if (patch[field] !== undefined) {
        values.push(patch[field]);
        assignments.push(`${columnByField[field]} = $${values.length}`);
      }
    }
    if (assignments.length === 0) {
      return this.getById(id);
    }
    values.push(id);
    const result = await this.pool.query(
      `UPDATE livestock_passport.passport_transfers SET ${assignments.join(', ')}
       WHERE id = $${values.length} RETURNING ${TRANSFER_COLS}`,
      values
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Passport transfer '${id}' not found`);
    }
    return transferFromRow(result.rows[0]);
  }
}

export function createPgPassportTransferRepository(pool: pg.Pool): PgPassportTransferRepository {
  return new PgPassportTransferRepository(pool);
}

