import type pg from 'pg';
import type {
  GeoCreditBasisFlags,
  GeoCreditFactorBreakdown,
  GeoCreditFactorStatus
} from '@agric-platform/shared';
import { composeWhere, eq, mapPgError, ts, type WhereClause } from '../pg/pg-repository.base.js';
import type {
  GeoCreditShadowCriteria,
  GeoCreditShadowRecord,
  GeoCreditShadowRepository
} from './geo-credit-shadow.repository.js';

/**
 * PostgreSQL repository for geo-verified credit shadow scores over
 * credit.geo_credit_shadow_scores (migration 028). Self-contained SQL keeps
 * the wave additive — no edits to the shared row-mappers module.
 */

interface ShadowRow {
  id: string;
  application_id: string;
  factor_score: number | null;
  status: GeoCreditFactorStatus;
  breakdown: GeoCreditFactorBreakdown;
  basis: GeoCreditBasisFlags;
  input_fingerprint: string;
  computed_at: string;
}

function fromRow(row: ShadowRow): GeoCreditShadowRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    factorScore: row.factor_score === null ? null : Number(row.factor_score),
    status: row.status,
    breakdown: row.breakdown,
    basis: row.basis,
    inputFingerprint: row.input_fingerprint,
    computedAt: ts(row.computed_at)
  };
}

export class PgGeoCreditShadowRepository implements GeoCreditShadowRepository {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(record: GeoCreditShadowRecord): Promise<GeoCreditShadowRecord> {
    try {
      await this.pool.query(
        `INSERT INTO credit.geo_credit_shadow_scores
           (id, application_id, factor_score, status, breakdown, basis, input_fingerprint, computed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (application_id, input_fingerprint)
         DO UPDATE SET factor_score = EXCLUDED.factor_score,
                       status = EXCLUDED.status,
                       breakdown = EXCLUDED.breakdown,
                       basis = EXCLUDED.basis,
                       computed_at = EXCLUDED.computed_at`,
        [
          record.id,
          record.applicationId,
          record.factorScore,
          record.status,
          JSON.stringify(record.breakdown),
          JSON.stringify(record.basis),
          record.inputFingerprint,
          record.computedAt
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return record;
  }

  async find(criteria: GeoCreditShadowCriteria): Promise<GeoCreditShadowRecord[]> {
    const where = this.where(criteria);
    const result = await this.pool.query<ShadowRow>(
      `SELECT * FROM credit.geo_credit_shadow_scores ${where.where}
       ORDER BY computed_at DESC, id`,
      where.params
    );
    return result.rows.map(fromRow);
  }

  async findOne(criteria: GeoCreditShadowCriteria): Promise<GeoCreditShadowRecord | undefined> {
    return (await this.find(criteria))[0];
  }

  async all(): Promise<GeoCreditShadowRecord[]> {
    const result = await this.pool.query<ShadowRow>(
      'SELECT * FROM credit.geo_credit_shadow_scores ORDER BY computed_at DESC, id'
    );
    return result.rows.map(fromRow);
  }

  private where(criteria: GeoCreditShadowCriteria): WhereClause {
    return composeWhere(
      eq('application_id', criteria.applicationId),
      eq('input_fingerprint', criteria.inputFingerprint)
    );
  }
}

export function createPgGeoCreditShadowRepository(pool: pg.Pool): PgGeoCreditShadowRepository {
  return new PgGeoCreditShadowRepository(pool);
}
