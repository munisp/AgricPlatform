import type { AuditEvent } from '@agric-platform/shared';
import { chainTimestamp, GENESIS_HASH, linkAuditEvent } from '../../core/audit-chain.js';

export interface AuditCriteria {
  actorId?: string;
  entityType?: string;
}

/**
 * Append-only audit event log (admin.audit_events, NDPR/NDPA requirement).
 *
 * Chain-extension contract (audit C2-11): `append()` is the ONLY write path
 * for new audit events. It must derive prevHash from the current tail and
 * persist the linked event atomically — no interleavable read-then-write —
 * so concurrent or multi-replica writers cannot fork the hash chain.
 * `record()` remains as a trusted raw insert for tests/tooling that inject
 * fully-hashed (e.g. forged) history.
 */
export interface AuditRepository {
  /** Atomically extends the hash chain with a new event. */
  append(event: Omit<AuditEvent, 'prevHash' | 'hash'>): Promise<AuditEvent>;
  /** Raw trusted insert of a fully-hashed event (tests/tooling only). */
  record(event: AuditEvent): Promise<AuditEvent>;
  list(criteria?: AuditCriteria): Promise<AuditEvent[]>;
}

export class InMemoryAuditRepository implements AuditRepository {
  private readonly events: AuditEvent[] = [];

  async append(unsigned: Omit<AuditEvent, 'prevHash' | 'hash'>): Promise<AuditEvent> {
    // The whole read-tail → link → push sequence is synchronous (no awaits),
    // so concurrent append() calls run to completion one at a time and can
    // never interleave into a forked chain — the single-process analogue of
    // the database's UNIQUE(prev_hash) serialization.
    const tail = this.events[this.events.length - 1];
    // Keep chain order aligned with (createdAt, id) ordering even when
    // concurrent callers share a millisecond.
    const createdAt = chainTimestamp(tail?.createdAt, unsigned.createdAt);
    const event = linkAuditEvent({ ...unsigned, createdAt }, tail?.hash ?? GENESIS_HASH);
    this.events.push(event);
    return event;
  }

  async record(event: AuditEvent): Promise<AuditEvent> {
    this.events.push(event);
    return event;
  }

  async list(criteria?: AuditCriteria): Promise<AuditEvent[]> {
    return this.events.filter(
      (event) =>
        (!criteria?.actorId || event.actorId === criteria.actorId) &&
        (!criteria?.entityType || event.entityType === criteria.entityType)
    );
  }
}

export function createInMemoryAuditRepository(): InMemoryAuditRepository {
  return new InMemoryAuditRepository();
}
