import type pg from 'pg';
import type { CoopScoreBand, CoopScoreFactorBreakdown } from '@agric-platform/shared';
import { mapPgError, ts } from '../pg/pg-repository.base.js';
import type { CoopScoreRecord, CoopScoreRepository } from './coop-score.repository.js';

/**
 * PostgreSQL repository for cooperative scores over credit.coop_scores
 * (migration 072). APPEND-ONLY: the only write is the guarded INSERT below
 * (next version computed in the same statement, ON CONFLICT on the
 * (cooperative_id, inputs_hash) idempotency index makes recompute a no-op).
 * Self-contained SQL keeps the wave additive — no edits to shared mappers.
 */

interface CoopScoreRow {
  id: string;
  cooperative_id: string;
  version: number;
  score: number;
  band: CoopScoreBand;
  factor_scores: CoopScoreFactorBreakdown[];
  inputs_hash: string;
  computed_at: string;
}

function fromRow(row: CoopScoreRow): CoopScoreRecord {
  return {
    id: row.id,
    cooperativeId: row.cooperative_id,
    version: Number(row.version),
    score: Number(row.score),
    band: row.band,
    factors: row.factor_scores,
    inputsHash: row.inputs_hash,
    computedAt: ts(row.computed_at)
  };
}

export class PgCoopScoreRepository implements CoopScoreRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Appends the next version in ONE statement (the subquery computes
   * max(version)+1 per cooperative). ON CONFLICT on the idempotency index
   * (cooperative_id, inputs_hash) DO NOTHING makes recompute with identical
   * inputs a no-op — undefined is returned and no row is written. A
   * concurrent append racing the version subquery surfaces as 23505 on the
   * (cooperative_id, version) index (fail loud via mapPgError), never a
   * silently overwritten history row.
   */
  async append(record: Omit<CoopScoreRecord, 'version'>): Promise<CoopScoreRecord | undefined> {
    try {
      const result = await this.pool.query<CoopScoreRow>(
        `INSERT INTO credit.coop_scores
           (id, cooperative_id, version, score, band, factor_scores, inputs_hash, computed_at)
         SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3, $4, $5, $6, $7
           FROM credit.coop_scores
          WHERE cooperative_id = $2
         ON CONFLICT (cooperative_id, inputs_hash) DO NOTHING
         RETURNING *`,
        [
          record.id,
          record.cooperativeId,
          record.score,
          record.band,
          JSON.stringify(record.factors),
          record.inputsHash,
          record.computedAt
        ]
      );
      const row = result.rows[0];
      return row ? fromRow(row) : undefined;
    } catch (error) {
      mapPgError(error);
    }
  }

  async latestFor(cooperativeId: string): Promise<CoopScoreRecord | undefined> {
    const result = await this.pool.query<CoopScoreRow>(
      `SELECT * FROM credit.coop_scores
        WHERE cooperative_id = $1
        ORDER BY version DESC
        LIMIT 1`,
      [cooperativeId]
    );
    const row = result.rows[0];
    return row ? fromRow(row) : undefined;
  }

  async historyFor(cooperativeId: string): Promise<CoopScoreRecord[]> {
    const result = await this.pool.query<CoopScoreRow>(
      `SELECT * FROM credit.coop_scores
        WHERE cooperative_id = $1
        ORDER BY version DESC`,
      [cooperativeId]
    );
    return result.rows.map(fromRow);
  }

  async findByInputsHash(
    cooperativeId: string,
    inputsHash: string
  ): Promise<CoopScoreRecord | undefined> {
    const result = await this.pool.query<CoopScoreRow>(
      `SELECT * FROM credit.coop_scores
        WHERE cooperative_id = $1 AND inputs_hash = $2
        LIMIT 1`,
      [cooperativeId, inputsHash]
    );
    const row = result.rows[0];
    return row ? fromRow(row) : undefined;
  }
}

export function createPgCoopScoreRepository(pool: pg.Pool): PgCoopScoreRepository {
  return new PgCoopScoreRepository(pool);
}
