import type pg from 'pg';
import type { AuditEvent } from '@agric-platform/shared';
import type { DomainEvent } from '../../core/domain-events.service.js';
import { auditMapper, outboxMapper } from '../pg/row-mappers.js';
import type { AuditCriteria, AuditRepository } from './audit.repository.js';
import type { OutboxRecord, OutboxRepository } from './outbox.repository.js';

/** Append-only audit event log over admin.audit_events. */
export class PgAuditRepository implements AuditRepository {
  constructor(private readonly pool: pg.Pool) {}

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
      `SELECT ${auditMapper.columns.join(', ')} FROM admin.audit_events${where} ORDER BY created_at`,
      params
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

  async list(): Promise<DomainEvent[]> {
    const result = await this.pool.query(
      `SELECT ${outboxMapper.columns.join(', ')} FROM events.outbox ORDER BY occurred_at`
    );
    return result.rows.map((row) => outboxMapper.fromRow(row));
  }

  async listRecords(): Promise<OutboxRecord[]> {
    const result = await this.pool.query(
      `SELECT ${outboxMapper.columns.join(', ')}, published_at, attempts, dead_lettered_at
         FROM events.outbox ORDER BY occurred_at`
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
}

export function createPgAuditRepository(pool: pg.Pool): PgAuditRepository {
  return new PgAuditRepository(pool);
}

export function createPgOutboxRepository(pool: pg.Pool): PgOutboxRepository {
  return new PgOutboxRepository(pool);
}
