import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AuditEvent } from '@agric-platform/shared';
import { newId } from '../common/async-repository.js';
import { AUDIT_REPOSITORY } from '../database/persistence.tokens.js';
import type { AuditCriteria, AuditRepository } from '../database/repositories/audit.repository.js';

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

/** prevHash of the first event in the chain. */
export const GENESIS_HASH = '0'.repeat(64);

/** Deterministic JSON (sorted keys, recursive) so hashes are stable across processes. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJSON(entry)}`);
  return `{${entries.join(',')}}`;
}

/** Chain hash (plan §A.6): sha256 over the canonical event payload + prevHash. */
export function hashAuditEvent(event: Omit<AuditEvent, 'hash'>, prevHash: string): string {
  return createHash('sha256').update(canonicalJSON(event) + prevHash).digest('hex');
}

/**
 * Audit log for admin and sensitive operations (NDPR/NDPA requirement).
 * Persists through the injected AuditRepository (in-memory by default,
 * admin.audit_events in PostgreSQL).
 *
 * Tamper evidence (observability plan §A.6): every record carries
 * `prevHash`/`hash` forming a hash chain (genesis = 64 zeros); `verify()`
 * re-walks the chain and reports the first broken link. The in-memory tail
 * is re-seeded from the repository on first use after boot so restarts
 * continue the persisted chain instead of forking it.
 */
@Injectable()
export class AuditService {
  /** Hash of the last event in the chain; undefined = not yet loaded. */
  private lastHash: string | undefined;

  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly audits: AuditRepository
  ) {}

  async record(input: RecordAuditInput): Promise<AuditEvent> {
    const prevHash = await this.currentHash();
    const unsigned: Omit<AuditEvent, 'hash'> = {
      id: newId('audit'),
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
      prevHash,
      ...(input.requestId ? { requestId: input.requestId } : {})
    };
    const event: AuditEvent = { ...unsigned, hash: hashAuditEvent(unsigned, prevHash) };
    const recorded = await this.audits.record(event);
    this.lastHash = event.hash;
    return recorded;
  }

  async list(filter?: AuditCriteria): Promise<AuditEvent[]> {
    return this.audits.list(filter);
  }

  /**
   * Re-walks the persisted chain. An event is broken when it lacks hash
   * fields, its prevHash does not match the running tail, or its payload no
   * longer hashes to the stored value (i.e. it was tampered with).
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

  /** Tail hash, lazily resumed from the repository after a restart. */
  private async currentHash(): Promise<string> {
    if (this.lastHash === undefined) {
      const existing = await this.audits.list();
      this.lastHash = existing.length > 0
        ? (existing[existing.length - 1].hash ?? GENESIS_HASH)
        : GENESIS_HASH;
    }
    return this.lastHash;
  }
}
