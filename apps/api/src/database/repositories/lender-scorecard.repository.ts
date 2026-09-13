/**
 * Lender Lens (Stage 27, innovation #20) — scorecard persistence port.
 *
 * Storage contract (migration 079, analytics schema):
 *   - versions are immutable: publishing an existing version with a
 *     DIFFERENT definition is rejected (version pinning); re-publishing the
 *     identical definition is an idempotent no-op;
 *   - scorecards are immutable per (lender_partner_id, version, period):
 *     inserting the same key with the same payload_hash is an idempotent
 *     replay (returns the stored row); a divergent payload for the same key
 *     is a conflict, never an overwrite;
 *   - benchmark cells upsert per (version, period, metric, band) — they are
 *     recomputed deterministically from stored scorecards.
 *
 * The DI token is kept local to this file (lakehouse.config.ts pattern) so
 * the shared persistence.tokens.ts / database.module.ts stay untouched; the
 * provider is registered by the Lender Lens module.
 */
import { ConflictException } from '@nestjs/common';
import { canonicalJson } from '../../modules/analytics/lender-scorecard.js';
import type { BenchmarkCell, LenderScorecardPayload, ScorecardVersionDefinition } from '../../modules/analytics/lender-scorecard.js';

export const LENDER_SCORECARD_REPOSITORY = Symbol('LENDER_SCORECARD_REPOSITORY');

export interface LenderScorecardVersionRow {
  version: string;
  definition: ScorecardVersionDefinition;
  publishedAt: string;
  publishedBy?: string;
}

export interface LenderScorecardRow {
  id: string;
  lenderPartnerId: string;
  version: string;
  /** Lagos calendar month 'YYYY-MM'. */
  period: string;
  payload: LenderScorecardPayload;
  /** sha256 hex over the canonical JSON of payload. */
  payloadHash: string;
  generatedAt: string;
}

export interface PortfolioBenchmarkRow extends BenchmarkCell {
  version: string;
  period: string;
  generatedAt: string;
}

export interface PublishVersionResult {
  row: LenderScorecardVersionRow;
  /** false = idempotent replay (identical definition already published). */
  created: boolean;
}

export interface InsertScorecardResult {
  row: LenderScorecardRow;
  /** false = idempotent replay (identical payload already stored). */
  created: boolean;
}

export interface LenderScorecardRepository {
  publishVersion(row: LenderScorecardVersionRow): Promise<PublishVersionResult>;
  scorecardVersion(version: string): Promise<LenderScorecardVersionRow | undefined>;
  latestScorecardVersion(): Promise<LenderScorecardVersionRow | undefined>;
  listScorecardVersions(): Promise<LenderScorecardVersionRow[]>;

  insertScorecard(row: LenderScorecardRow): Promise<InsertScorecardResult>;
  scorecard(
    lenderPartnerId: string,
    version: string,
    period: string
  ): Promise<LenderScorecardRow | undefined>;
  /** All scorecards for one (version, period) — benchmark computation input. */
  scorecardsForPeriod(version: string, period: string): Promise<LenderScorecardRow[]>;

  upsertBenchmark(row: PortfolioBenchmarkRow): Promise<void>;
  benchmarks(version: string, period: string): Promise<PortfolioBenchmarkRow[]>;
}

/** Same definition? Compared on canonical JSON (sorted keys, compact). */
function sameDefinition(a: ScorecardVersionDefinition, b: ScorecardVersionDefinition): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** In-memory implementation (default outside PostgreSQL deployments). */
export class InMemoryLenderScorecardRepository implements LenderScorecardRepository {
  private readonly versions = new Map<string, LenderScorecardVersionRow>();
  private readonly scorecards = new Map<string, LenderScorecardRow>();
  private readonly benchmarkRows = new Map<string, PortfolioBenchmarkRow>();

  private static scorecardKey(lenderPartnerId: string, version: string, period: string): string {
    return `${lenderPartnerId}|${version}|${period}`;
  }

  async publishVersion(row: LenderScorecardVersionRow): Promise<PublishVersionResult> {
    const existing = this.versions.get(row.version);
    if (existing) {
      if (!sameDefinition(existing.definition, row.definition)) {
        throw new ConflictException(
          `scorecard version '${row.version}' is already published with a different definition (versions are immutable)`
        );
      }
      return { row: existing, created: false };
    }
    this.versions.set(row.version, row);
    return { row, created: true };
  }

  async scorecardVersion(version: string): Promise<LenderScorecardVersionRow | undefined> {
    return this.versions.get(version);
  }

  async latestScorecardVersion(): Promise<LenderScorecardVersionRow | undefined> {
    const all = await this.listScorecardVersions();
    return all[all.length - 1];
  }

  async listScorecardVersions(): Promise<LenderScorecardVersionRow[]> {
    return [...this.versions.values()].sort(
      (a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.version.localeCompare(b.version)
    );
  }

  async insertScorecard(row: LenderScorecardRow): Promise<InsertScorecardResult> {
    const key = InMemoryLenderScorecardRepository.scorecardKey(
      row.lenderPartnerId,
      row.version,
      row.period
    );
    const existing = this.scorecards.get(key);
    if (existing) {
      if (existing.payloadHash !== row.payloadHash) {
        throw new ConflictException(
          `scorecard for lender '${row.lenderPartnerId}' version '${row.version}' period '${row.period}' ` +
            'already exists with a different payload (scorecards are immutable)'
        );
      }
      return { row: existing, created: false };
    }
    this.scorecards.set(key, row);
    return { row, created: true };
  }

  async scorecard(
    lenderPartnerId: string,
    version: string,
    period: string
  ): Promise<LenderScorecardRow | undefined> {
    return this.scorecards.get(
      InMemoryLenderScorecardRepository.scorecardKey(lenderPartnerId, version, period)
    );
  }

  async scorecardsForPeriod(version: string, period: string): Promise<LenderScorecardRow[]> {
    return [...this.scorecards.values()].filter(
      (row) => row.version === version && row.period === period
    );
  }

  async upsertBenchmark(row: PortfolioBenchmarkRow): Promise<void> {
    this.benchmarkRows.set(`${row.version}|${row.period}|${row.metric}|${row.band}`, row);
  }

  async benchmarks(version: string, period: string): Promise<PortfolioBenchmarkRow[]> {
    return [...this.benchmarkRows.values()].filter(
      (row) => row.version === version && row.period === period
    );
  }
}

export function createInMemoryLenderScorecardRepository(): InMemoryLenderScorecardRepository {
  return new InMemoryLenderScorecardRepository();
}
