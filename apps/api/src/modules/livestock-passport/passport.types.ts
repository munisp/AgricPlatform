import { createHash } from 'node:crypto';
import { canonicalJson, GENESIS_PREV_HASH } from '../traceability/traceability.types.js';

/**
 * Digital livestock passport domain types + the passport hash-chain scheme
 * (wave-livestock-passport, migration 036, schema `livestock_passport`).
 *
 * The chain deliberately mirrors the traceability custody chain: every
 * passport event embeds the sha256 of its canonical payload chained to the
 * previous event's hash, so rewriting any stored field breaks recomputation
 * at that event and every descendant — tamper-evidence WITHOUT database
 * triggers. The canonical-JSON serialisation and the genesis prev-hash are
 * REUSED from the traceability module (one hashing convention platform-wide).
 */

export const PASSPORT_EVENT_TYPES = [
  'ISSUED',
  'TRANSFER_INITIATED',
  'TRANSFER_CONFIRMED',
  'TRANSFER_CANCELLED',
  'SUSPENDED',
  'REINSTATED',
  'REVOKED'
] as const;
export type PassportEventType = (typeof PASSPORT_EVENT_TYPES)[number];

export const PASSPORT_STATUSES = ['active', 'suspended', 'revoked'] as const;
export type PassportStatus = (typeof PASSPORT_STATUSES)[number];

export const PASSPORT_TRANSFER_STATUSES = ['pending', 'confirmed', 'cancelled'] as const;
export type PassportTransferStatus = (typeof PASSPORT_TRANSFER_STATUSES)[number];

/**
 * Honest provenance label for the external animal-ID authority / RFID tag
 * registry check performed at issue time: 'stub' is the deterministic
 * simulated driver (default), 'live' a configured authority that answered,
 * 'unavailable' a live driver that was configured but unreachable (the
 * passport is NOT issued in that case at the API layer — the label exists
 * for operator-facing status surfaces), 'none' when the animal carries no
 * tag/eid to check.
 */
export type TagCheckBasis = 'stub' | 'live' | 'unavailable' | 'none';

export interface LivestockPassport {
  id: string;
  /** One passport per registered animal (livestock.animals). */
  animalId: string;
  /** Public HMAC-signed verification code (see passport-code.ts). */
  passportCode: string;
  codeNonce: string;
  /** Full HMAC-SHA256 hex signature over the canonical code payload. */
  codeSignature: string;
  /** Current owner (mirrors livestock.animals.owner_user_id; updated on confirmed transfers). */
  ownerUserId: string;
  status: PassportStatus;
  tagCheckBasis: TagCheckBasis;
  tagCheckDetail?: string;
  issuedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PassportEvent {
  id: string;
  passportId: string;
  /** Per-passport monotonic position (0-based); part of the chain ordering. */
  seq: number;
  type: PassportEventType;
  actorId: string;
  /** Structured event facts (e.g. transfer id, counterparty) — part of the hash. */
  payload: Record<string, unknown>;
  prevEventHash: string;
  eventHash: string;
  createdAt: string;
}

export interface PassportTransfer {
  id: string;
  passportId: string;
  animalId: string;
  fromUserId: string;
  toUserId: string;
  status: PassportTransferStatus;
  note?: string;
  /** livestock.ownership_transfers row written when the buyer confirms. */
  executedTransferId?: string;
  initiatedAt: string;
  confirmedAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------------ */
/* Hash-chain scheme (mirrors traceability.types.ts)                         */
/* ------------------------------------------------------------------------ */

/**
 * The exact payload the hash covers. `payload` is canonicalised through the
 * shared canonicalJson (sorted keys, undefined dropped) so writer and
 * verifier agree byte-for-byte. The event id and createdAt are deliberately
 * NOT hashed: they are storage metadata, while the chain protects the
 * passport facts.
 */
export interface PassportHashPayload {
  actorId: string;
  passportId: string;
  payload: Record<string, unknown>;
  prevEventHash: string;
  seq: number;
  type: PassportEventType;
}

export function passportHashPayloadOf(
  event: Pick<PassportEvent, 'actorId' | 'passportId' | 'payload' | 'prevEventHash' | 'seq' | 'type'>
): PassportHashPayload {
  return {
    actorId: event.actorId,
    passportId: event.passportId,
    payload: event.payload ?? {},
    prevEventHash: event.prevEventHash,
    seq: event.seq,
    type: event.type
  };
}

/** sha256 hex over the canonical JSON of the hash payload. */
export function computePassportEventHash(payload: PassportHashPayload): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

export interface PassportEventVerification {
  eventId: string;
  passportId: string;
  seq: number;
  type: PassportEventType;
  /** Recomputed hash equals the stored event_hash. */
  hashValid: boolean;
  /** Stored prev_event_hash equals the previous event's hash (or genesis). */
  prevLinkValid: boolean;
  valid: boolean;
  expectedHash: string;
  storedHash: string;
}

export interface PassportChainVerification {
  passportId: string;
  eventCount: number;
  valid: boolean;
  /** Hash of the chain head (undefined for an empty chain). */
  headHash?: string;
  events: PassportEventVerification[];
}

/**
 * Recomputes a passport's chain from the stored events (ascending seq).
 * Detects both payload tampering (hash mismatch) and chain surgery
 * (prev-link mismatch, seq gaps).
 */
export function verifyPassportChain(
  passportId: string,
  events: readonly PassportEvent[]
): PassportChainVerification {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const results: PassportEventVerification[] = [];
  let expectedPrev = GENESIS_PREV_HASH;
  let expectedSeq = 0;
  for (const event of ordered) {
    const expectedHash = computePassportEventHash(passportHashPayloadOf(event));
    const hashValid = expectedHash === event.eventHash;
    const prevLinkValid = event.prevEventHash === expectedPrev && event.seq === expectedSeq;
    results.push({
      eventId: event.id,
      passportId: event.passportId,
      seq: event.seq,
      type: event.type,
      hashValid,
      prevLinkValid,
      valid: hashValid && prevLinkValid,
      expectedHash,
      storedHash: event.eventHash
    });
    expectedPrev = event.eventHash;
    expectedSeq = event.seq + 1;
  }
  return {
    passportId,
    eventCount: ordered.length,
    valid: results.every((result) => result.valid),
    headHash: ordered.length > 0 ? ordered[ordered.length - 1].eventHash : undefined,
    events: results
  };
}

export { GENESIS_PREV_HASH };
