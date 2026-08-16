import type pg from 'pg';
import type { AuditAnchor } from '@agric-platform/shared';
import { chainTimestamp, GENESIS_HASH, linkAuditAnchor } from '../../core/audit-chain.js';
import { ts, type RowMapper } from '../pg/pg-repository.base.js';
import type { AuditAnchorRepository } from './audit-anchor.repository.js';

/**
 * PostgreSQL anchoring checkpoint log over audit.anchors (Stage 23,
 * migration 047) — the anchor-side counterpart of PgAuditRepository in
 * core.pg-repository.ts. Self-contained per the per-domain
 * `*.pg-repository.ts` convention: its row mapper lives here because the
 * audit.anchors table is written/read only by this repository.
 *
 * Anchor creation is serialized in the database exactly like event appends
 * (audit C2-11): migration 047 puts UNIQUE(prev_anchor_hash) on
 * audit.anchors, and append() extends the anchor chain through a single
 * guarded INSERT … SELECT whose WHERE re-reads the current anchor tip
 * (created_at DESC, id DESC) inside the statement. A racing anchor either
 * fails the tip guard (0 rows) or collides on the unique index (SQLSTATE
 * 23505); the loser re-reads the new tip and retries up to
 * ANCHOR_APPEND_MAX_ATTEMPTS times, then fails loudly.
 */

/** snake_case row ↔ camelCase mapping for audit.anchors. */
export const auditAnchorMapper: RowMapper<AuditAnchor> = {
  columns: [
    'id',
    'anchored_through_event_id',
    'tip_hash',
    'event_count',
    'prev_anchor_hash',
    'anchor_hash',
    'created_at'
  ],
  // Every AuditAnchor field is required, so every key is always present
  // (anchoredThroughEventId is an explicit null for empty-chain anchors —
  // canonicalJSON handles null deterministically; it is present-but-UNDEFINED
  // keys that would change the hashed payload, the Stage 22 hash-stability
  // lesson). event_count is bigint: pg returns it as a string, so it is
  // normalized to a number here or the hash payload would not reproduce the
  // writer's. created_at round-trips exactly through ts().
  fromRow: (row) => ({
    id: row.id as string,
    anchoredThroughEventId: (row.anchored_through_event_id as string | null) ?? null,
    tipHash: row.tip_hash as string,
    eventCount: Number(row.event_count),
    prevAnchorHash: row.prev_anchor_hash as string,
    anchorHash: row.anchor_hash as string,
    createdAt: ts(row.created_at)
  }),
  toRow: (item) => ({
    id: item.id,
    anchored_through_event_id: item.anchoredThroughEventId,
    tip_hash: item.tipHash,
    event_count: item.eventCount,
    prev_anchor_hash: item.prevAnchorHash,
    anchor_hash: item.anchorHash,
    created_at: item.createdAt
  })
};

/** Tip ordering for the anchor chain: created_at with a deterministic id tiebreaker. */
const ANCHOR_TIP_SQL = `SELECT ${auditAnchorMapper.columns.join(', ')} FROM audit.anchors ORDER BY created_at DESC, id DESC LIMIT 1`;

/** Scalar tip-hash subquery embedded in the guarded anchor INSERT's WHERE. */
const ANCHOR_TIP_HASH_SQL =
  'SELECT anchor_hash FROM audit.anchors ORDER BY created_at DESC, id DESC LIMIT 1';

/** Bounded retries for anchor-chain races before failing loudly (mirrors C2-11). */
const ANCHOR_APPEND_MAX_ATTEMPTS = 3;

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

/**
 * Jittered backoff between fork-race retries (same reasoning as the event
 * chain's): without it, N concurrent creators re-read the same fresh tip in
 * lockstep and can collide again on every attempt.
 */
function forkRetryDelayMs(attempt: number): number {
  return 5 * attempt * attempt + Math.floor(Math.random() * 10 * attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PgAuditAnchorRepository implements AuditAnchorRepository {
  constructor(private readonly pool: pg.Pool) {}

  async append(unsigned: Omit<AuditAnchor, 'prevAnchorHash' | 'anchorHash'>): Promise<AuditAnchor> {
    for (let attempt = 1; attempt <= ANCHOR_APPEND_MAX_ATTEMPTS; attempt += 1) {
      const tip = await this.pool.query(ANCHOR_TIP_SQL);
      const tipRow = tip.rows[0] as Record<string, unknown> | undefined;
      const prevAnchorHash = (tipRow?.anchor_hash as string | undefined) ?? GENESIS_HASH;
      // pg returns timestamptz as Date; normalize before comparing.
      const tipCreatedAt = tipRow?.created_at ? ts(tipRow.created_at) : undefined;
      // Child anchor must sort after its parent under (created_at, id) so
      // list()/verifyAnchors() walk the anchor chain in link order.
      const createdAt = chainTimestamp(tipCreatedAt, unsigned.createdAt);
      const anchor = linkAuditAnchor({ ...unsigned, createdAt }, prevAnchorHash);
      const row = auditAnchorMapper.toRow(anchor);
      const columns = Object.keys(row);
      // $1..$n = column values, $n+1 = claimed parent anchor hash, $n+2 = genesis.
      const claimed = `$${columns.length + 1}`;
      const genesis = `$${columns.length + 2}`;
      try {
        const result = await this.pool.query(
          `INSERT INTO audit.anchors (${columns.join(', ')})
           SELECT ${columns.map((_, i) => `$${i + 1}`).join(', ')}
           WHERE COALESCE((${ANCHOR_TIP_HASH_SQL}), ${genesis}) = ${claimed}`,
          [...columns.map((column) => row[column]), prevAnchorHash, GENESIS_HASH]
        );
        if (result.rowCount === 1) {
          return anchor;
        }
        // Anchor tip moved between the read and this statement (concurrent creator).
      } catch (error) {
        // UNIQUE(prev_anchor_hash) rejected a racing anchor that committed first.
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
      if (attempt < ANCHOR_APPEND_MAX_ATTEMPTS) {
        await sleep(forkRetryDelayMs(attempt));
      }
    }
    throw new Error(
      `audit anchor append failed after ${ANCHOR_APPEND_MAX_ATTEMPTS} attempts — ` +
        'sustained concurrent fork contention on audit.anchors'
    );
  }

  async record(anchor: AuditAnchor): Promise<AuditAnchor> {
    const row = auditAnchorMapper.toRow(anchor);
    const columns = Object.keys(row);
    await this.pool.query(
      `INSERT INTO audit.anchors (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      columns.map((column) => row[column])
    );
    return anchor;
  }

  async latest(): Promise<AuditAnchor | null> {
    const result = await this.pool.query(ANCHOR_TIP_SQL);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? auditAnchorMapper.fromRow(row) : null;
  }

  async list(): Promise<AuditAnchor[]> {
    const result = await this.pool.query(
      `SELECT ${auditAnchorMapper.columns.join(', ')} FROM audit.anchors ORDER BY created_at, id`
    );
    return result.rows.map((row) => auditAnchorMapper.fromRow(row));
  }
}

export function createPgAuditAnchorRepository(pool: pg.Pool): PgAuditAnchorRepository {
  return new PgAuditAnchorRepository(pool);
}
