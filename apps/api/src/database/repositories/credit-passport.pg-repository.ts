import type pg from 'pg';
import { NotFoundException } from '@nestjs/common';
import type {
  CreditPassportCredential,
  CreditPassportDisclosure,
  CreditPassportPayload,
  CreditPassportStatus
} from '../../modules/credit-passport/credit-passport.types.js';
import { mapPgError } from '../pg/pg-repository.base.js';
import type {
  CreditPassportCredentialCriteria,
  CreditPassportCredentialRepository,
  CreditPassportDisclosureCriteria,
  CreditPassportDisclosureRepository
} from './credit-passport.repository.js';

/**
 * Credit Passport pg implementations (Stage 27, Innovation 7; schema
 * `credit_passport`, migration 065). Credential versions are INSERT-only:
 * the single UPDATE path mutates status/revoked_at only (supersede +
 * revoke), so payload, hashes and code material are immutable after insert
 * and the per-farmer hash chain is the tamper-evidence layer (no DB
 * triggers). jsonb columns are serialised explicitly.
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

/* ------------------------------ credentials ------------------------------ */

const CREDENTIAL_COLS =
  'id, user_id, version, payload, payload_hash, prev_hash, passport_code, code_nonce, code_signature, status, issued_by, issued_at, revoked_at';

function credentialFromRow(row: Record<string, unknown>): CreditPassportCredential {
  return {
    id: str(row, 'id'),
    userId: str(row, 'user_id'),
    version: num(row, 'version'),
    payload: row['payload'] as CreditPassportPayload,
    payloadHash: str(row, 'payload_hash'),
    prevHash: str(row, 'prev_hash'),
    passportCode: str(row, 'passport_code'),
    codeNonce: str(row, 'code_nonce'),
    codeSignature: str(row, 'code_signature'),
    status: str(row, 'status') as CreditPassportStatus,
    issuedBy: str(row, 'issued_by'),
    issuedAt: ts(row, 'issued_at'),
    revokedAt: tsOrUndef(row, 'revoked_at')
  };
}

export class PgCreditPassportCredentialRepository implements CreditPassportCredentialRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(credential: CreditPassportCredential): Promise<CreditPassportCredential> {
    try {
      await this.pool.query(
        `INSERT INTO credit_passport.credentials (${CREDENTIAL_COLS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          credential.id,
          credential.userId,
          credential.version,
          JSON.stringify(credential.payload),
          credential.payloadHash,
          credential.prevHash,
          credential.passportCode,
          credential.codeNonce,
          credential.codeSignature,
          credential.status,
          credential.issuedBy,
          credential.issuedAt,
          credential.revokedAt ?? null
        ]
      );
      return credential;
    } catch (error) {
      mapPgError(error);
    }
  }

  async findById(id: string): Promise<CreditPassportCredential | undefined> {
    const result = await this.pool.query(
      `SELECT ${CREDENTIAL_COLS} FROM credit_passport.credentials WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? credentialFromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<CreditPassportCredential> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`Credit passport credential '${id}' not found`);
    }
    return item;
  }

  async findByCode(passportCode: string): Promise<CreditPassportCredential | undefined> {
    const result = await this.pool.query(
      `SELECT ${CREDENTIAL_COLS} FROM credit_passport.credentials WHERE passport_code = $1`,
      [passportCode]
    );
    return result.rows[0] ? credentialFromRow(result.rows[0]) : undefined;
  }

  async findActiveByUserId(userId: string): Promise<CreditPassportCredential | undefined> {
    const result = await this.pool.query(
      `SELECT ${CREDENTIAL_COLS} FROM credit_passport.credentials
       WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );
    return result.rows[0] ? credentialFromRow(result.rows[0]) : undefined;
  }

  async listByUserId(userId: string): Promise<CreditPassportCredential[]> {
    const result = await this.pool.query(
      `SELECT ${CREDENTIAL_COLS} FROM credit_passport.credentials
       WHERE user_id = $1 ORDER BY version ASC`,
      [userId]
    );
    return result.rows.map(credentialFromRow);
  }

  async find(criteria: CreditPassportCredentialCriteria): Promise<CreditPassportCredential[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (criteria.userId) {
      values.push(criteria.userId);
      where.push(`user_id = $${values.length}`);
    }
    if (criteria.status) {
      values.push(criteria.status);
      where.push(`status = $${values.length}`);
    }
    const result = await this.pool.query(
      `SELECT ${CREDENTIAL_COLS} FROM credit_passport.credentials${
        where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
      } ORDER BY user_id ASC, version ASC`,
      values
    );
    return result.rows.map(credentialFromRow);
  }

  async update(
    id: string,
    patch: Partial<Pick<CreditPassportCredential, 'status' | 'revokedAt'>>
  ): Promise<CreditPassportCredential> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const columnByField = { status: 'status', revokedAt: 'revoked_at' } as const;
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
      `UPDATE credit_passport.credentials SET ${assignments.join(', ')}
       WHERE id = $${values.length} RETURNING ${CREDENTIAL_COLS}`,
      values
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Credit passport credential '${id}' not found`);
    }
    return credentialFromRow(result.rows[0]);
  }
}

export function createPgCreditPassportCredentialRepository(
  pool: pg.Pool
): PgCreditPassportCredentialRepository {
  return new PgCreditPassportCredentialRepository(pool);
}

/* ------------------------------ disclosures ------------------------------ */

const DISCLOSURE_COLS =
  'id, credential_id, user_id, disclosed_to, scope, consent_recorded_at, expires_at, revoked_at, created_at';

function disclosureFromRow(row: Record<string, unknown>): CreditPassportDisclosure {
  return {
    id: str(row, 'id'),
    credentialId: str(row, 'credential_id'),
    userId: str(row, 'user_id'),
    disclosedTo: str(row, 'disclosed_to'),
    scope: str(row, 'scope'),
    consentRecordedAt: ts(row, 'consent_recorded_at'),
    expiresAt: ts(row, 'expires_at'),
    revokedAt: tsOrUndef(row, 'revoked_at'),
    createdAt: ts(row, 'created_at')
  };
}

export class PgCreditPassportDisclosureRepository implements CreditPassportDisclosureRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(disclosure: CreditPassportDisclosure): Promise<CreditPassportDisclosure> {
    try {
      await this.pool.query(
        `INSERT INTO credit_passport.disclosures (${DISCLOSURE_COLS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          disclosure.id,
          disclosure.credentialId,
          disclosure.userId,
          disclosure.disclosedTo,
          disclosure.scope,
          disclosure.consentRecordedAt,
          disclosure.expiresAt,
          disclosure.revokedAt ?? null,
          disclosure.createdAt
        ]
      );
      return disclosure;
    } catch (error) {
      mapPgError(error);
    }
  }

  async findById(id: string): Promise<CreditPassportDisclosure | undefined> {
    const result = await this.pool.query(
      `SELECT ${DISCLOSURE_COLS} FROM credit_passport.disclosures WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? disclosureFromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<CreditPassportDisclosure> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`Credit passport disclosure '${id}' not found`);
    }
    return item;
  }

  async find(criteria: CreditPassportDisclosureCriteria): Promise<CreditPassportDisclosure[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (criteria.credentialId) {
      values.push(criteria.credentialId);
      where.push(`credential_id = $${values.length}`);
    }
    if (criteria.userId) {
      values.push(criteria.userId);
      where.push(`user_id = $${values.length}`);
    }
    if (criteria.disclosedTo) {
      values.push(criteria.disclosedTo);
      where.push(`disclosed_to = $${values.length}`);
    }
    const result = await this.pool.query(
      `SELECT ${DISCLOSURE_COLS} FROM credit_passport.disclosures${
        where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
      } ORDER BY created_at ASC`,
      values
    );
    return result.rows.map(disclosureFromRow);
  }

  async update(
    id: string,
    patch: Partial<Pick<CreditPassportDisclosure, 'revokedAt'>>
  ): Promise<CreditPassportDisclosure> {
    if (patch.revokedAt === undefined) {
      return this.getById(id);
    }
    const result = await this.pool.query(
      `UPDATE credit_passport.disclosures SET revoked_at = $1
       WHERE id = $2 RETURNING ${DISCLOSURE_COLS}`,
      [patch.revokedAt, id]
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Credit passport disclosure '${id}' not found`);
    }
    return disclosureFromRow(result.rows[0]);
  }
}

export function createPgCreditPassportDisclosureRepository(
  pool: pg.Pool
): PgCreditPassportDisclosureRepository {
  return new PgCreditPassportDisclosureRepository(pool);
}
