import { Inject, Injectable } from '@nestjs/common';
import type { AuditEvent } from '@agric-platform/shared';
import { newId } from '../common/async-repository.js';
import { AUDIT_REPOSITORY } from '../database/persistence.tokens.js';
import type { AuditCriteria, AuditRepository } from '../database/repositories/audit.repository.js';
import { GENESIS_HASH, hashAuditEvent } from './audit-chain.js';

export { canonicalJSON, GENESIS_HASH, hashAuditEvent, linkAuditEvent } from './audit-chain.js';

export interface RecordAuditInput {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  /** Correlates the record with the HTTP request that caused it. */
  requestId?: string;
}

export interface AuditVerification {
  valid: boolean;
  /** Id of the first event whose hash/link check failed. */
  brokenAt?: string;
  /** Number of events verified in this walk (Wave P). */
  checked?: number;
}

/**
 * Audit log for admin and sensitive operations (NDPR/NDPA requirement).
 * Persists through the injected AuditRepository (in-memory by default,
 * admin.audit_events in PostgreSQL).
 *
 * Tamper evidence (observability plan §A.6): every record carries
 * `prevHash`/`hash` forming a hash chain (genesis = 64 zeros); `verify()`
 * re-walks the chain and reports the first broken link.
 *
 * Fork safety (audit C2-11): chain extension is atomic inside the
 * repository's `append()` — the tail is read and linked in the same
 * serialized step (UNIQUE(prev_hash) + guarded INSERT on PostgreSQL, a
 * synchronous link-and-push in memory). This service intentionally keeps NO
 * per-process tail cache: under the multi-replica HPA every replica used to
 * hold an independent lastHash and fork the chain. Restarts and concurrent
 * writers now all extend the same persisted chain.
 *
 * Residual risk (documented, follow-up): deleting the last N rows still
 * leaves a valid shorter chain — the chain has no length checkpoint. Closing
 * that hole requires an external anchoring checkpoint (periodically
 * notarizing tail hash + length outside the database); see migration 043.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly audits: AuditRepository
  ) {}

  async record(input: RecordAuditInput): Promise<AuditEvent> {
    const unsigned: Omit<AuditEvent, 'prevHash' | 'hash'> = {
      id: newId('audit'),
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
      ...(input.requestId ? { requestId: input.requestId } : {})
    };
    // Atomic chain extension (prevHash + hash) happens inside the repository.
    return this.audits.append(unsigned);
  }

  async list(filter?: AuditCriteria): Promise<AuditEvent[]> {
    return this.audits.list(filter);
  }

  /**
   * Re-walks the persisted chain. An event is broken when it lacks hash
   * fields, its prevHash does not match the running tail, or its payload no
   * longer hashes to the stored value (i.e. it was tampered with). A forked
   * history (two events claiming the same prevHash) is detected the same
   * way: the second branch's prevHash cannot match the running tail.
   *
   * Wave P: optional [fromId, toId] range bounds the walk to a contiguous
   * slice. Inside a range the first event's prevHash is trusted (it links
   * to history outside the slice); every later link and every payload hash
   * is still verified, and the first broken link is reported.
   */
  async verify(range?: { fromId?: string; toId?: string }): Promise<AuditVerification> {
    const all = await this.audits.list();
    const start = range?.fromId ? all.findIndex((event) => event.id === range.fromId) : 0;
    if (start < 0) {
      return { valid: false, brokenAt: range?.fromId, checked: 0 };
    }
    const end = range?.toId ? all.findIndex((event) => event.id === range.toId) : all.length - 1;
    if (range?.toId && end < 0) {
      return { valid: false, brokenAt: range.toId, checked: 0 };
    }
    const slice = all.slice(start, end + 1);
    // Full-chain walks anchor at genesis; ranged walks trust the slice head's link.
    let expected = start === 0 ? GENESIS_HASH : (slice[0]?.prevHash ?? GENESIS_HASH);
    let checked = 0;
    for (const event of slice) {
      if (!event.hash || !event.prevHash) {
        return { valid: false, brokenAt: event.id, checked };
      }
      if (event.prevHash !== expected) {
        return { valid: false, brokenAt: event.id, checked };
      }
      const { hash, ...unsigned } = event;
      if (hashAuditEvent(unsigned, event.prevHash) !== event.hash) {
        return { valid: false, brokenAt: event.id, checked };
      }
      expected = event.hash;
      checked += 1;
    }
    return { valid: true, checked };
  }
}
