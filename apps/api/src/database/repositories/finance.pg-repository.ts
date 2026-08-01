import type pg from 'pg';
import type { CreditProfile, VaultDocument } from '@agric-platform/shared';
import {
  composeWhere,
  eq,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import { creditProfileMapper, documentMapper } from '../pg/row-mappers.js';
import type { CreditProfileRepository } from './credit-profile.repository.js';
import type { DocumentCriteria, DocumentRepository } from './document.repository.js';

/** Credit profile repository over finance.credit_profiles, keyed by user_id. */
export class PgCreditProfileRepository implements CreditProfileRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findByUserId(userId: string): Promise<CreditProfile | undefined> {
    const result = await this.pool.query(
      `SELECT ${creditProfileMapper.columns.join(', ')} FROM finance.credit_profiles WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0] ? creditProfileMapper.fromRow(result.rows[0]) : undefined;
  }

  async upsert(profile: CreditProfile): Promise<CreditProfile> {
    const row = creditProfileMapper.toRow(profile);
    const columns = Object.keys(row);
    const assignments = columns
      .filter((column) => column !== 'user_id')
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(', ');
    await this.pool.query(
      `INSERT INTO finance.credit_profiles (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (user_id) DO UPDATE SET ${assignments}, updated_at = now()`,
      columns.map((column) => row[column])
    );
    return profile;
  }
}

export function documentCriteriaSql(criteria: DocumentCriteria): WhereClause {
  return composeWhere(eq('user_id', criteria.userId), eq('status', criteria.status));
}

export class PgDocumentRepository
  extends PgRepositoryBase<VaultDocument, DocumentCriteria>
  implements DocumentRepository
{
  constructor(pool: pg.Pool) {
    super(pool, { table: 'finance.documents', mapper: documentMapper, criteria: documentCriteriaSql });
  }
}

export function createPgCreditProfileRepository(pool: pg.Pool): PgCreditProfileRepository {
  return new PgCreditProfileRepository(pool);
}

export function createPgDocumentRepository(pool: pg.Pool): PgDocumentRepository {
  return new PgDocumentRepository(pool);
}
