/**
 * PostgreSQL repository for Lender Lens scorecards (Stage 27, innovation
 * #20; analytics schema, migration 079).
 *
 * Immutability is enforced with guarded inserts: ON CONFLICT ... DO NOTHING
 * RETURNING makes the insert race-safe; when nothing was inserted the stored
 * row is re-read and compared — an identical replay is idempotent, a
 * divergent definition/payload for the same key raises ConflictException
 * (409), never an overwrite.
 */
import { ConflictException } from '@nestjs/common';
import type pg from 'pg';
import { canonicalJson } from '../../modules/analytics/lender-scorecard.js';
import type {
  InsertScorecardResult,
  LenderScorecardRepository,
  LenderScorecardRow,
  LenderScorecardVersionRow,
  PortfolioBenchmarkRow,
  PublishVersionResult
} from './lender-scorecard.repository.js';
import type { LenderScorecardPayload, ScorecardVersionDefinition } from '../../modules/analytics/lender-scorecard.js';

function versionFromRow(row: Record<string, unknown>): LenderScorecardVersionRow {
  return {
    version: String(row.version),
    definition: row.definition as ScorecardVersionDefinition,
    publishedAt: new Date(String(row.published_at)).toISOString(),
    ...(row.published_by ? { publishedBy: String(row.published_by) } : {})
  };
}

function scorecardFromRow(row: Record<string, unknown>): LenderScorecardRow {
  return {
    id: String(row.id),
    lenderPartnerId: String(row.lender_partner_id),
    version: String(row.version),
    period: String(row.period),
    payload: row.payload as LenderScorecardPayload,
    payloadHash: String(row.payload_hash),
    generatedAt: new Date(String(row.generated_at)).toISOString()
  };
}

function benchmarkFromRow(row: Record<string, unknown>): PortfolioBenchmarkRow {
  return {
    version: String(row.version),
    period: String(row.period),
    metric: row.metric as PortfolioBenchmarkRow['metric'],
    band: String(row.band),
    lenderCount: Number(row.lender_count),
    valueBps: row.value_bps === null || row.value_bps === undefined ? null : Number(row.value_bps),
    suppressed: Boolean(row.suppressed),
    generatedAt: new Date(String(row.generated_at)).toISOString()
  };
}

export class PgLenderScorecardRepository implements LenderScorecardRepository {
  constructor(private readonly pool: pg.Pool) {}

  async publishVersion(row: LenderScorecardVersionRow): Promise<PublishVersionResult> {
    const inserted = await this.pool.query(
      `INSERT INTO analytics.lender_scorecard_versions (version, definition, published_at, published_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (version) DO NOTHING
       RETURNING version, definition, published_at, published_by`,
      [row.version, JSON.stringify(row.definition), row.publishedAt, row.publishedBy ?? null]
    );
    if (inserted.rows.length > 0) {
      return { row: versionFromRow(inserted.rows[0]), created: true };
    }
    const existing = await this.pool.query(
      `SELECT version, definition, published_at, published_by
       FROM analytics.lender_scorecard_versions WHERE version = $1`,
      [row.version]
    );
    const stored = versionFromRow(existing.rows[0] as Record<string, unknown>);
    if (canonicalJson(stored.definition) !== canonicalJson(row.definition)) {
      throw new ConflictException(
        `scorecard version '${row.version}' is already published with a different definition (versions are immutable)`
      );
    }
    return { row: stored, created: false };
  }

  async scorecardVersion(version: string): Promise<LenderScorecardVersionRow | undefined> {
    const result = await this.pool.query(
      `SELECT version, definition, published_at, published_by
       FROM analytics.lender_scorecard_versions WHERE version = $1`,
      [version]
    );
    return result.rows[0] ? versionFromRow(result.rows[0]) : undefined;
  }

  async latestScorecardVersion(): Promise<LenderScorecardVersionRow | undefined> {
    const result = await this.pool.query(
      `SELECT version, definition, published_at, published_by
       FROM analytics.lender_scorecard_versions
       ORDER BY published_at DESC, version DESC LIMIT 1`
    );
    return result.rows[0] ? versionFromRow(result.rows[0]) : undefined;
  }

  async listScorecardVersions(): Promise<LenderScorecardVersionRow[]> {
    const result = await this.pool.query(
      `SELECT version, definition, published_at, published_by
       FROM analytics.lender_scorecard_versions
       ORDER BY published_at ASC, version ASC`
    );
    return result.rows.map(versionFromRow);
  }

  async insertScorecard(row: LenderScorecardRow): Promise<InsertScorecardResult> {
    const inserted = await this.pool.query(
      `INSERT INTO analytics.lender_scorecards
         (id, lender_partner_id, version, period, payload, payload_hash, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (lender_partner_id, version, period) DO NOTHING
       RETURNING id, lender_partner_id, version, period, payload, payload_hash, generated_at`,
      [
        row.id,
        row.lenderPartnerId,
        row.version,
        row.period,
        JSON.stringify(row.payload),
        row.payloadHash,
        row.generatedAt
      ]
    );
    if (inserted.rows.length > 0) {
      return { row: scorecardFromRow(inserted.rows[0]), created: true };
    }
    const stored = await this.scorecard(row.lenderPartnerId, row.version, row.period);
    if (!stored) {
      // Unique-violation race on the primary key with a different natural
      // key — surface as a conflict, never silently succeed.
      throw new ConflictException(`scorecard id '${row.id}' already exists`);
    }
    if (stored.payloadHash !== row.payloadHash) {
      throw new ConflictException(
        `scorecard for lender '${row.lenderPartnerId}' version '${row.version}' period '${row.period}' ` +
          'already exists with a different payload (scorecards are immutable)'
      );
    }
    return { row: stored, created: false };
  }

  async scorecard(
    lenderPartnerId: string,
    version: string,
    period: string
  ): Promise<LenderScorecardRow | undefined> {
    const result = await this.pool.query(
      `SELECT id, lender_partner_id, version, period, payload, payload_hash, generated_at
       FROM analytics.lender_scorecards
       WHERE lender_partner_id = $1 AND version = $2 AND period = $3`,
      [lenderPartnerId, version, period]
    );
    return result.rows[0] ? scorecardFromRow(result.rows[0]) : undefined;
  }

  async scorecardsForPeriod(version: string, period: string): Promise<LenderScorecardRow[]> {
    const result = await this.pool.query(
      `SELECT id, lender_partner_id, version, period, payload, payload_hash, generated_at
       FROM analytics.lender_scorecards
       WHERE version = $1 AND period = $2
       ORDER BY lender_partner_id ASC`,
      [version, period]
    );
    return result.rows.map(scorecardFromRow);
  }

  async upsertBenchmark(row: PortfolioBenchmarkRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO analytics.portfolio_benchmarks
         (version, period, metric, band, lender_count, value_bps, suppressed, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (version, period, metric, band) DO UPDATE SET
         lender_count = EXCLUDED.lender_count,
         value_bps = EXCLUDED.value_bps,
         suppressed = EXCLUDED.suppressed,
         generated_at = EXCLUDED.generated_at`,
      [
        row.version,
        row.period,
        row.metric,
        row.band,
        row.lenderCount,
        row.valueBps,
        row.suppressed,
        row.generatedAt
      ]
    );
  }

  async benchmarks(version: string, period: string): Promise<PortfolioBenchmarkRow[]> {
    const result = await this.pool.query(
      `SELECT version, period, metric, band, lender_count, value_bps, suppressed, generated_at
       FROM analytics.portfolio_benchmarks
       WHERE version = $1 AND period = $2
       ORDER BY metric ASC, band ASC`,
      [version, period]
    );
    return result.rows.map(benchmarkFromRow);
  }
}

export function createPgLenderScorecardRepository(pool: pg.Pool): PgLenderScorecardRepository {
  return new PgLenderScorecardRepository(pool);
}
