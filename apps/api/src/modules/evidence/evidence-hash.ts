import { createHash } from 'node:crypto';
import type { EvidenceItem } from '@agric-platform/shared';
import { canonicalJSON, GENESIS_HASH } from '../../core/audit-chain.js';

/**
 * Evidence Locker hash-chain primitives (Stage 27 Innovation 13).
 *
 * Same construction as the platform audit chain (core/audit-chain.ts):
 * itemHash = sha256(canonicalJSON(payload) + prevHash), genesis = 64 zeros,
 * one chain PER CASE (caseType, caseId). Kept free of NestJS/repository
 * dependencies so the service layer and both persistence implementations
 * extend chains with byte-identical semantics.
 *
 * The hashed payload covers the IMMUTABLE provenance fields only. `status`
 * is deliberately excluded: it is the single mutable column (active ->
 * sealed -> expunged via guarded CAS), and including it would break the
 * chain on every legitimate transition — exactly what the NDPA expunge
 * tombstone doctrine forbids.
 */

/** The immutable, hash-covered payload of an evidence item. */
export type EvidenceItemPayload = Omit<EvidenceItem, 'itemHash' | 'status'>;

/** Hash of an empty chain (same 64-zero genesis as the audit chain). */
export const EVIDENCE_GENESIS_HASH = GENESIS_HASH;

/**
 * Explicit field pick into the hashed payload. NEVER a rest-spread that
 * drops status: a present-but-undefined or accidentally-included key would
 * change the canonical JSON and silently fork hash semantics between writer
 * and verifier (the Stage 22 hash-stability lesson).
 */
export function evidenceItemPayload(
  item: Omit<EvidenceItem, 'itemHash'>
): EvidenceItemPayload {
  return {
    id: item.id,
    caseType: item.caseType,
    caseId: item.caseId,
    uploaderId: item.uploaderId,
    objectKey: item.objectKey,
    sha256: item.sha256,
    prevHash: item.prevHash,
    capturedAt: item.capturedAt,
    uploadedAt: item.uploadedAt,
    mime: item.mime,
    sizeBytes: item.sizeBytes
  };
}

/** Chain hash: sha256 over the canonical immutable payload + prevHash. */
export function hashEvidenceItem(payload: EvidenceItemPayload): string {
  return createHash('sha256')
    .update(canonicalJSON(payload) + payload.prevHash)
    .digest('hex');
}

/**
 * Links an unsigned item to a parent hash. Pure — the caller must make the
 * tip read and the append atomic (UNIQUE (case_type, case_id, prev_hash) +
 * guarded INSERT on PostgreSQL; a synchronous link-and-push in memory).
 */
export function linkEvidenceItem(
  unsigned: Omit<EvidenceItem, 'prevHash' | 'itemHash'>,
  prevHash: string
): EvidenceItem {
  const linked: Omit<EvidenceItem, 'itemHash'> = { ...unsigned, prevHash };
  return { ...linked, itemHash: hashEvidenceItem(evidenceItemPayload(linked)) };
}

export interface EvidenceChainVerification {
  valid: boolean;
  /** Items whose link + payload hash recomputed cleanly. */
  checked: number;
  /** Id of the first item whose link or hash check failed. */
  brokenAt?: string;
  /** Ids of every item that failed integrity (never serve these as valid). */
  tamperedItemIds: string[];
}

/**
 * Re-walks one case's chain (items in chain order — uploadedAt, id). An
 * item is broken when its prevHash does not match the running tail (a
 * rewrite, delete, or fork) or its immutable payload no longer hashes to
 * itemHash (a field edit). Tampered items are flagged for the caller; the
 * service layer MUST NOT serve them as valid evidence.
 */
export function verifyEvidenceChain(items: EvidenceItem[]): EvidenceChainVerification {
  let expected = EVIDENCE_GENESIS_HASH;
  let checked = 0;
  const tamperedItemIds: string[] = [];
  for (const item of items) {
    const intact =
      item.prevHash === expected && hashEvidenceItem(evidenceItemPayload(item)) === item.itemHash;
    if (!intact) {
      tamperedItemIds.push(item.id);
      return { valid: false, checked, brokenAt: item.id, tamperedItemIds };
    }
    expected = item.itemHash;
    checked += 1;
  }
  return { valid: true, checked, tamperedItemIds };
}

/** Head hash of a chain segment (genesis for an empty case). */
export function chainHead(items: EvidenceItem[]): string {
  return items.length === 0 ? EVIDENCE_GENESIS_HASH : items[items.length - 1].itemHash;
}

/** OTel attribute bucket for evidence.item.record spans (no raw sizes). */
export function evidenceSizeClass(sizeBytes: number): string {
  if (sizeBytes <= 64 * 1024) return 'le_64kib';
  if (sizeBytes <= 1024 * 1024) return 'le_1mib';
  if (sizeBytes <= 10 * 1024 * 1024) return 'le_10mib';
  return 'gt_10mib';
}
