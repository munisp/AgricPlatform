import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AnimalHealthRecord, HealthRecordSignaturePayload } from '@agric-platform/shared';
import { canonicalHealthRecordPayload } from '@agric-platform/shared';

/**
 * Vet digital signatures for the animal-health ledger (wave L1b, blueprint
 * F3.4). Reuses the HMAC-SHA256 approach of the QR attendance codes: the
 * signature authenticates the canonical payload (vet identity + signing
 * timestamp + animal + product/batch/dose), keyed by VET_SIGNING_SECRET
 * (see config/livestock-health.config.ts). Verification is constant-time.
 */

/** HMAC-SHA256 signature (base64url) over the canonical record payload. */
export function signHealthRecord(payload: HealthRecordSignaturePayload, secret: string): string {
  return createHmac('sha256', secret)
    .update(canonicalHealthRecordPayload(payload))
    .digest('base64url');
}

/** Rebuilds the signed payload view of a stored record. */
export function healthRecordPayloadOf(record: AnimalHealthRecord): HealthRecordSignaturePayload {
  return {
    animalId: record.animalId,
    recordType: record.recordType,
    product: record.product,
    batchNumber: record.batchNumber,
    dose: record.dose,
    administeredAt: record.administeredAt,
    vetUserId: record.vetUserId,
    signedAt: record.signedAt
  };
}

export type HealthRecordVerification = { ok: true } | { ok: false; reason: 'signature' };

/**
 * Verifies a stored record's signature against the shared secret. Any field
 * tamper (animal, product, batch, dose, timestamps, vet identity) changes
 * the canonical payload and fails verification.
 */
export function verifyHealthRecordSignature(
  record: AnimalHealthRecord,
  secret: string
): HealthRecordVerification {
  const expected = signHealthRecord(healthRecordPayloadOf(record), secret);
  const providedBuf = Buffer.from(record.signature);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, reason: 'signature' };
  }
  return { ok: true };
}
