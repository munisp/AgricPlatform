import { createHash } from 'node:crypto';
import type { AuditAnchor, AuditEvent } from '@agric-platform/shared';

/**
 * Tamper-evident audit hash chain primitives (observability plan §A.6).
 *
 * Kept free of NestJS/repository dependencies so both the service layer and
 * the persistence layer (in-memory + PostgreSQL repositories) can extend the
 * chain with byte-identical semantics.
 */

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
 * Chain timestamp (audit C2-11): a child must always sort AFTER its parent
 * under ORDER BY created_at, id, or verify() would walk the chain out of
 * order. Concurrent writers can share a millisecond (or run on skewed
 * replica clocks), so when the parent's timestamp is not strictly earlier
 * the child is bumped 1ms past it. Worst-case drift is contention × 1ms.
 */
export function chainTimestamp(parentCreatedAt: string | undefined, createdAt: string): string {
  if (!parentCreatedAt) {
    return createdAt;
  }
  const parent = Date.parse(parentCreatedAt);
  const own = Date.parse(createdAt);
  return own > parent ? createdAt : new Date(parent + 1).toISOString();
}

/**
 * Links an unsigned event to a parent hash: sets prevHash and computes the
 * chain hash. Pure — the caller is responsible for making the read of the
 * parent and the append atomic (audit C2-11).
 */
export function linkAuditEvent(
  unsigned: Omit<AuditEvent, 'prevHash' | 'hash'>,
  prevHash: string
): AuditEvent {
  const linked: Omit<AuditEvent, 'hash'> = { ...unsigned, prevHash };
  return { ...linked, hash: hashAuditEvent(linked, prevHash) };
}

/**
 * Anchor-chain hash (Stage 23): identical construction to the event chain —
 * sha256 over the canonical anchor payload (prevAnchorHash included, matching
 * the event chain's shape) + prevAnchorHash. Sharing canonicalJSON keeps
 * anchor hashes byte-stable across processes and repositories.
 */
export function hashAuditAnchor(
  anchor: Omit<AuditAnchor, 'anchorHash'>,
  prevAnchorHash: string
): string {
  return createHash('sha256').update(canonicalJSON(anchor) + prevAnchorHash).digest('hex');
}

/**
 * Links an unsigned anchor to the previous anchor hash. Pure, like
 * linkAuditEvent — the caller must make the parent read + insert atomic
 * (UNIQUE(prev_anchor_hash) + guarded INSERT on PostgreSQL, a synchronous
 * link-and-push in memory).
 */
export function linkAuditAnchor(
  unsigned: Omit<AuditAnchor, 'prevAnchorHash' | 'anchorHash'>,
  prevAnchorHash: string
): AuditAnchor {
  const linked: Omit<AuditAnchor, 'anchorHash'> = { ...unsigned, prevAnchorHash };
  return { ...linked, anchorHash: hashAuditAnchor(linked, prevAnchorHash) };
}
