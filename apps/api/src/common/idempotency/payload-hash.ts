import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * Service-level idempotency payload fingerprinting (Stage 27 WP-G11, V2
 * idempotency-consistency audit). Mirrors the Idempotency-Key interceptor's
 * request-hash contract and the escrow payout rail's payloadHash doctrine:
 * the record persisted under a client idempotency key carries a canonical
 * hash of the request payload it was created from, so
 *   - same key + same payload  → replay the original record;
 *   - same key + DIFFERENT payload → 409 IDEMPOTENCY_PAYLOAD_MISMATCH
 *     (fail closed — never silently bind a new meaning to a used key).
 * Rows written before this change carry no hash and replay as legacy
 * records (same doctrine as the interceptor's pre-envelope entries).
 */

/**
 * Deterministic JSON form: object keys sorted recursively, undefined
 * properties dropped. Two structurally identical payloads fingerprint
 * identically regardless of key order; two different payloads collide only
 * under a sha256 collision.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalize(item)).join(',') + ']';
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, fieldValue]) => fieldValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, fieldValue]) => JSON.stringify(key) + ':' + canonicalize(fieldValue));
  return '{' + entries.join(',') + '}';
}

/** Canonical payload fingerprint: sha256 hex over the sorted-key JSON form. */
export function hashIdempotencyPayload(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}

/**
 * Replay guard for an idempotency-keyed record. A record WITHOUT a stored
 * hash predates WP-G11 and replays (legacy); a stored hash that differs
 * from the request hash is a client error and fails closed with 409.
 */
export function assertSameIdempotencyPayload(
  idempotencyKey: string,
  storedPayloadHash: string | undefined,
  requestPayloadHash: string
): void {
  if (storedPayloadHash !== undefined && storedPayloadHash !== requestPayloadHash) {
    throw new ConflictException(
      `IDEMPOTENCY_PAYLOAD_MISMATCH: idempotency key '${idempotencyKey}' was already ` +
        'used with a different payload'
    );
  }
}
