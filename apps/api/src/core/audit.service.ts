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
   */
  async verify(): Promise<AuditVerification> {
    let expected = GENESIS_HASH;
    for (const event of await this.audits.list()) {
      if (!event.hash || !event.prevHash) {
        return { valid: false, brokenAt: event.id };
      }
      if (event.prevHash !== expected) {
        return { valid: false, brokenAt: event.id };
      }
      const { hash, ...unsigned } = event;
      if (hashAuditEvent(unsigned, event.prevHash) !== event.hash) {
        return { valid: false, brokenAt: event.id };
      }
      expected = event.hash;
    }
    return { valid: true };
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
