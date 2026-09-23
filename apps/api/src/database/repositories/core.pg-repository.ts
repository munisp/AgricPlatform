import type pg from 'pg';
import type { AuditEvent } from '@agric-platform/shared';
import { chainTimestamp, GENESIS_HASH, linkAuditEvent } from '../../core/audit-chain.js';
import type { DomainEvent } from '../../core/domain-events.service.js';
import { auditMapper, outboxMapper } from '../pg/row-mappers.js';
import type { AuditCriteria, AuditRepository } from './audit.repository.js';
import {
  boundOutboxListLimit,
  type OutboxRecord,
  type OutboxRepository
} from './outbox.repository.js';

/** Tail ordering for the audit chain: created_at with a deterministic id tiebreaker. */
const AUDIT_TAIL_SQL =
  'SELECT hash, created_at FROM admin.audit_events ORDER BY created_at DESC, id DESC LIMIT 1';

/** Scalar tail-hash subquery embedded in the guarded INSERT's WHERE. */
const AUDIT_TAIL_HASH_SQL =
  'SELECT hash FROM admin.audit_events ORDER BY created_at DESC, id DESC LIMIT 1';

/** Bounded retries for chain-extension races before failing loudly (audit C2-11). */
const AUDIT_APPEND_MAX_ATTEMPTS = 3;

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

/**
 * Jittered backoff between fork-race retries: without it, N concurrent
 * writers re-read the same fresh tail in lockstep and can collide again on
 * every attempt.
 */
function forkRetryDelayMs(attempt: number): number {
  return 5 * attempt * attempt + Math.floor(Math.random() * 10 * attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Append-only audit event log over admin.audit_events.
 *
 * Chain extension (audit C2-11) is serialized in the database: migration 043
 * puts UNIQUE(prev_hash) on admin.audit_events, and append() extends the
 * chain through a single guarded INSERT … SELECT whose WHERE re-reads the
 * current tail (created_at DESC, id DESC) inside the statement. Two
 * concurrent appends claiming the same parent either fail the tail guard
 * (0 rows) or collide on the unique index (SQLSTATE 23505); the loser
 * re-reads the new tail and retries up to AUDIT_APPEND_MAX_ATTEMPTS times,
 * then fails loudly. No per-process tail cache is consulted, so every HPA
 * replica extends the same single chain.
 */
export class PgAuditRepository implements AuditRepository {
  constructor(private readonly pool: pg.Pool) {}

  async append(unsigned: Omit<AuditEvent, 'prevHash' | 'hash'>): Promise<AuditEvent> {
    for (let attempt = 1; attempt <= AUDIT_APPEND_MAX_ATTEMPTS; attempt += 1) {
      const tail = await this.pool.query(AUDIT_TAIL_SQL);
      const tailRow = tail.rows[0] as { hash?: string; created_at?: Date | string } | undefined;
      const prevHash = tailRow?.hash ?? GENESIS_HASH;
      // pg returns timestamptz as Date; normalize before comparing.
      const tailCreatedAt =
        tailRow?.created_at instanceof Date
          ? tailRow.created_at.toISOString()
          : tailRow?.created_at;
      // Child must sort after its parent under (created_at, id) so verify()
      // walks the chain in link order even when writers share a millisecond.
      const createdAt = chainTimestamp(tailCreatedAt, unsigned.createdAt);
      const event = linkAuditEvent({ ...unsigned, createdAt }, prevHash);
      const row = auditMapper.toRow(event);
      const columns = Object.keys(row);
      // $1..$n = column values, $n+1 = claimed parent hash, $n+2 = genesis.
      const claimed = `$${columns.length + 1}`;
      const genesis = `$${columns.length + 2}`;
      try {
        const result = await this.pool.query(
          `INSERT INTO admin.audit_events (${columns.join(', ')})
           SELECT ${columns.map((_, i) => `$${i + 1}`).join(', ')}
           WHERE COALESCE((${AUDIT_TAIL_HASH_SQL}), ${genesis}) = ${claimed}`,
          [...columns.map((column) => row[column]), prevHash, GENESIS_HASH]
        );
        if (result.rowCount === 1) {
          return event;
        }
        // Tail moved between the read and this statement (concurrent writer).
      } catch (error) {
        // UNIQUE(prev_hash) rejected a racing append that committed first.
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
      if (attempt < AUDIT_APPEND_MAX_ATTEMPTS) {
        await sleep(forkRetryDelayMs(attempt));
      }
    }
    throw new Error(
      `audit chain append failed after ${AUDIT_APPEND_MAX_ATTEMPTS} attempts — ` +
        'sustained concurrent fork contention on admin.audit_events'
    );
  }

  async record(event: AuditEvent): Promise<AuditEvent> {
    const row = auditMapper.toRow(event);
    const columns = Object.keys(row);
    await this.pool.query(
      `INSERT INTO admin.audit_events (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      columns.map((column) => row[column])
    );
    return event;
  }

  async list(criteria?: AuditCriteria): Promise<AuditEvent[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (criteria?.actorId) {
      params.push(criteria.actorId);
      conditions.push(`actor_id = $${params.length}`);
    }
    if (criteria?.entityType) {
      params.push(criteria.entityType);
      conditions.push(`entity_type = $${params.length}`);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT ${auditMapper.columns.join(', ')} FROM admin.audit_events${where} ORDER BY created_at, id`,
      params
    );
    return result.rows.map((row) => auditMapper.fromRow(row));
  }

  /**
   * L-17: bounded page for chunked chain verification — one round-trip per
   * batch instead of materializing the whole append-only log in memory.
   */
  async listPage(offset: number, limit: number): Promise<AuditEvent[]> {
    const result = await this.pool.query(
      `SELECT ${auditMapper.columns.join(', ')} FROM admin.audit_events
       ORDER BY created_at, id LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows.map((row) => auditMapper.fromRow(row));
  }
}

/** Append-only domain event outbox over events.outbox. */
export class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly pool: pg.Pool) {}

  async append(event: DomainEvent): Promise<DomainEvent> {
    const row = outboxMapper.toRow(event);
    const columns = Object.keys(row);
    await this.pool.query(
      `INSERT INTO events.outbox (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      columns.map((column) => row[column])
    );
    return event;
  }

  /**
   * P2 perf: bounded read — the outbox is append-only and grows until the
   * retention sweep, so the list is capped (default
   * OUTBOX_LIST_DEFAULT_LIMIT, oldest rows first).
   */
  async list(limit?: number): Promise<DomainEvent[]> {
    const result = await this.pool.query(
      `SELECT ${outboxMapper.columns.join(', ')} FROM events.outbox ORDER BY occurred_at LIMIT $1`,
      [boundOutboxListLimit(limit)]
    );
    return result.rows.map((row) => outboxMapper.fromRow(row));
  }

  /** Bounded like list() above; repeated sweeps drain a deeper backlog. */
  async listRecords(limit?: number): Promise<OutboxRecord[]> {
    const result = await this.pool.query(
      `SELECT ${outboxMapper.columns.join(', ')}, published_at, attempts, dead_lettered_at
         FROM events.outbox ORDER BY occurred_at LIMIT $1`,
      [boundOutboxListLimit(limit)]
    );
    return result.rows.map((row) => ({
      event: outboxMapper.fromRow(row),
      attempts: (row.attempts as number) ?? 0,
      ...(row.published_at ? { publishedAt: (row.published_at as Date).toISOString() } : {}),
      ...(row.dead_lettered_at
        ? { deadLetteredAt: (row.dead_lettered_at as Date).toISOString() }
        : {})
    }));
  }

  async markPublished(id: string, publishedAt: string): Promise<void> {
    await this.pool.query('UPDATE events.outbox SET published_at = $2 WHERE id = $1', [
      id,
      publishedAt
    ]);
  }

  async recordAttempt(id: string): Promise<number> {
    const result = await this.pool.query(
      'UPDATE events.outbox SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
      [id]
    );
    return (result.rows[0]?.attempts as number) ?? 0;
  }

  async markDeadLetter(id: string, deadLetteredAt: string): Promise<void> {
    await this.pool.query('UPDATE events.outbox SET dead_lettered_at = $2 WHERE id = $1', [
      id,
      deadLetteredAt
    ]);
  }

  /**
   * V-79 redrive: clears dead_lettered_at and the attempt counter in one
   * statement, guarded on the row actually being dead-lettered — a row
   * that is merely pending (or missing) is never touched.
   */
  async resetDeadLetter(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE events.outbox
         SET dead_lettered_at = NULL, attempts = 0
       WHERE id = $1 AND dead_lettered_at IS NOT NULL`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async countPublishedBefore(cutoff: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT count(*)::int AS n FROM events.outbox
       WHERE published_at IS NOT NULL AND published_at < $1`,
      [cutoff]
    );
    return result.rows[0].n as number;
  }

  async anonymizePublishedBefore(cutoff: string): Promise<number> {
    // payload is jsonb NOT NULL, so the tombstone is '{}', never NULL; the
    // payload <> '{}' guard keeps repeated sweeps no-ops (idempotent).
    const result = await this.pool.query(
      `UPDATE events.outbox SET payload = '{}'::jsonb
       WHERE published_at IS NOT NULL AND published_at < $1 AND payload <> '{}'::jsonb`,
      [cutoff]
    );
    return result.rowCount ?? 0;
  }

  async purgePublishedBefore(cutoff: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM events.outbox
       WHERE published_at IS NOT NULL AND published_at < $1`,
      [cutoff]
    );
    return result.rowCount ?? 0;
  }
}

export function createPgAuditRepository(pool: pg.Pool): PgAuditRepository {
  return new PgAuditRepository(pool);
}

export function createPgOutboxRepository(pool: pg.Pool): PgOutboxRepository {
  return new PgOutboxRepository(pool);
}
