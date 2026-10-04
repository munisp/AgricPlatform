import type pg from 'pg';
import type { InboundEvent } from '@agric-platform/shared';
import { eq, PgRepositoryBase, type RowMapper, type WhereClause } from '../pg/pg-repository.base.js';
import { inboundEventMapper } from '../pg/row-mappers.js';
import type { InboundEventCriteria, InboundEventRepository } from './phase3.repository.js';

/**
 * integrations.inbound_events (010_external_bridges.sql). Dedupe-keyed:
 * recordIfAbsent uses INSERT ... ON CONFLICT (system, dedupe_key) DO NOTHING
 * — replay-safe under provider retries.
 */
export class PgInboundEventRepository
  extends PgRepositoryBase<InboundEvent, InboundEventCriteria>
  implements InboundEventRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'integrations.inbound_events',
      mapper: inboundEventMapper,
      criteria: (criteria) => eq('system', criteria.system) as WhereClause
    });
  }

  async recordIfAbsent(event: InboundEvent): Promise<boolean> {
    const row = inboundEventMapper.toRow(event);
    const columns = Object.keys(row);
    const result = await this.pool.query(
      `INSERT INTO integrations.inbound_events (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (system, dedupe_key) DO NOTHING`,
      columns.map((column) => row[column])
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markProcessed(id: string, processedAt: string): Promise<void> {
    await this.pool.query(
      'UPDATE integrations.inbound_events SET processed_at = $2 WHERE id = $1',
      [id, processedAt]
    );
  }

  /** V-27: retention sweeper support — rows processed before the cutoff. */
  async countProcessedBefore(cutoff: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT count(*)::int AS n FROM integrations.inbound_events
       WHERE processed_at IS NOT NULL AND processed_at < $1`,
      [cutoff]
    );
    return result.rows[0].n as number;
  }

  async anonymizeProcessedBefore(cutoff: string): Promise<number> {
    // payload is jsonb NOT NULL, so the tombstone is '{}', never NULL; the
    // payload <> '{}' guard keeps repeated sweeps no-ops (idempotent).
    const result = await this.pool.query(
      `UPDATE integrations.inbound_events SET payload = '{}'::jsonb
       WHERE processed_at IS NOT NULL AND processed_at < $1 AND payload <> '{}'::jsonb`,
      [cutoff]
    );
    return result.rowCount ?? 0;
  }

  async purgeProcessedBefore(cutoff: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM integrations.inbound_events
       WHERE processed_at IS NOT NULL AND processed_at < $1`,
      [cutoff]
    );
    return result.rowCount ?? 0;
  }
}

export function createPgInboundEventRepository(pool: pg.Pool): PgInboundEventRepository {
  return new PgInboundEventRepository(pool);
}

/* eslint-disable @typescript-eslint/no-unused-vars */
// RowMapper import retained for parity with sibling pg repositories.
const _mapperCheck: RowMapper<InboundEvent> = inboundEventMapper;
