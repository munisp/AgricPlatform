import { createHash } from 'node:crypto';
import { canonicalJson, GENESIS_PREV_HASH } from '../traceability/traceability.types.js';

/**
 * Stage 27 (Innovation 9): Geo-Sealed Delivery — location-verified escrow
 * release. A delivery attestation is a signed, hash-chained record that a
 * buyer or agent device was at the agreed drop point. Containment
 * (`withinGeofence`) is ALWAYS recomputed server-side from the signed
 * coordinates via H3Service — a client-supplied claim is never trusted.
 */

export const DELIVERY_ATTESTATION_ROLES = ['buyer', 'agent'] as const;
export type DeliveryAttestationRole = (typeof DELIVERY_ATTESTATION_ROLES)[number];

/**
 * How the device obtained its fix. `manual` is recorded HONESTLY when the
 * device reports no fix; policy then decides (manual alone can never
 * auto-release — it requires an explicit buyer confirm).
 */
export const DELIVERY_DEVICE_BASES = ['gps', 'network', 'manual'] as const;
export type DeliveryDeviceBasis = (typeof DELIVERY_DEVICE_BASES)[number];

/**
 * Append-only, hash-chained attestation row
 * (marketplace.delivery_attestations, migration 067). Same chain scheme as
 * livestock-passport events: per-escrow seq + prev_hash + payload_hash over
 * the canonical-JSON payload, genesis prev_hash = 64 zeroes.
 */
export interface DeliveryAttestation {
  id: string;
  escrowId: string;
  orderId: string;
  seq: number;
  attestedBy: string;
  role: DeliveryAttestationRole;
  lat: number;
  lng: number;
  /** Server-computed res-9 H3 cell of the attested coordinates. */
  h3Res9: string;
  /** Server-computed containment verdict — never the client's claim. */
  withinGeofence: boolean;
  deviceBasis: DeliveryDeviceBasis;
  attestedAt: string;
  prevHash: string;
  payloadHash: string;
}

/** The canonical payload that `payloadHash` commits to (everything but the hash itself). */
export type AttestationHashPayload = Omit<DeliveryAttestation, 'id' | 'payloadHash'>;

export function attestationHashPayloadOf(
  attestation: Omit<DeliveryAttestation, 'id' | 'payloadHash'>
): AttestationHashPayload {
  return {
    escrowId: attestation.escrowId,
    orderId: attestation.orderId,
    seq: attestation.seq,
    attestedBy: attestation.attestedBy,
    role: attestation.role,
    lat: attestation.lat,
    lng: attestation.lng,
    h3Res9: attestation.h3Res9,
    withinGeofence: attestation.withinGeofence,
    deviceBasis: attestation.deviceBasis,
    attestedAt: attestation.attestedAt,
    prevHash: attestation.prevHash
  };
}

/** sha256 over the canonical-JSON payload (deterministic, externally recomputable). */
export function computeAttestationHash(payload: AttestationHashPayload): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/**
 * Verifies one escrow's attestation chain end-to-end: sequential seq,
 * prev_hash linkage from the genesis, and every payload_hash recomputed.
 * Returns the first broken link index, or -1 when the chain is intact.
 */
export function verifyAttestationChain(events: readonly DeliveryAttestation[]): number {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.seq !== index || event.prevHash !== expectedPrev) {
      return index;
    }
    const expectedHash = computeAttestationHash(attestationHashPayloadOf(event));
    if (event.payloadHash !== expectedHash) {
      return index;
    }
    expectedPrev = event.payloadHash;
  }
  return -1;
}

export { GENESIS_PREV_HASH };
