import { createHash } from 'node:crypto';
import { canonicalJson, GENESIS_PREV_HASH } from '../traceability/traceability.types.js';

/**
 * Credit Passport domain types + the per-farmer credential hash-chain scheme
 * (Stage 27, Innovation 7; migration 065, schema `credit_passport`).
 *
 * The chain deliberately mirrors the livestock-passport / traceability
 * convention: every credential version embeds the sha256 of its canonical
 * payload chained to the previous version's payload_hash, so rewriting any
 * stored field breaks recomputation at that version and every descendant —
 * tamper-evidence WITHOUT database triggers. The canonical-JSON
 * serialisation and the genesis prev-hash are REUSED from the traceability
 * module (one hashing convention platform-wide).
 */

export const CREDIT_PASSPORT_STATUSES = ['active', 'superseded', 'revoked'] as const;
export type CreditPassportStatus = (typeof CREDIT_PASSPORT_STATUSES)[number];

/**
 * Honest provenance badge for one passport section, mirroring the
 * geo-credit honesty-label doctrine:
 *  - 'live'        — read from the owning module's repository at compose time
 *  - 'shadow'      — computed in shadow mode; NEVER decisional (the
 *                    geo-verified credit module's hard design constraint)
 *  - 'unavailable' — the source was stale/unreachable; the section is
 *                    emitted with this badge (or omitted) but NEVER
 *                    fabricated
 */
export type PassportSectionBasis = 'live' | 'shadow' | 'unavailable';

export interface PassportSection<T> {
  basis: PassportSectionBasis;
  /** Shadow sections are never decisional (geo-credit hard constraint). */
  decisional: boolean;
  data: T;
}

/** Repayment history section — composed from the credit suite (LIVE). */
export interface RepaymentSectionData {
  loanCount: number;
  completedLoans: number;
  activeLoans: number;
  defaultedLoans: number;
  installmentsDue: number;
  installmentsPaid: number;
  installmentsLateOrMissed: number;
  /** paid / due across all scheduled installments (0 when none due). */
  onTimeRatio: number;
  totalBorrowedKobo: number;
  totalRepaidKobo: number;
}

/** Learning certificates section — composed from the learning module (LIVE). */
export interface CertificatesSectionData {
  count: number;
  certificates: Array<{
    id: string;
    courseId: string;
    verificationCode: string;
    issuedAt: string;
  }>;
}

/** VSLA discipline section — composed from the vsla-carbon module (LIVE). */
export interface VslaSectionData {
  groupsJoined: number;
  activeMemberships: number;
  shareOutsReceived: number;
  totalSharedOutKobo: number;
  totalContributedKobo: number;
  loansTaken: number;
  loansRepaidInFull: number;
  loansOutstanding: number;
}

/**
 * Geo-verification factor section — composed from the credit
 * geo-verification shadow store. Always basis 'shadow' (or 'unavailable'
 * when no shadow score exists) and ALWAYS decisional: false.
 */
export interface GeoFactorSectionData {
  factorScore: number | null;
  status: 'computed' | 'unavailable';
  inputBasis: { flood: string; crop: string };
  /** Null when no shadow score has ever been computed. */
  computedAt: string | null;
}

/** The signed passport payload persisted as credentials.payload (jsonb). */
export interface CreditPassportPayload {
  holder: { userId: string; fullName: string };
  repayment?: PassportSection<RepaymentSectionData>;
  certificates?: PassportSection<CertificatesSectionData>;
  vsla?: PassportSection<VslaSectionData>;
  geoFactor?: PassportSection<GeoFactorSectionData>;
}

export interface CreditPassportCredential {
  id: string;
  userId: string;
  /** Per-farmer monotonic version (1-based); part of the chain ordering. */
  version: number;
  payload: CreditPassportPayload;
  payloadHash: string;
  /** Previous version's payload_hash (genesis = 64 zeroes for version 1). */
  prevHash: string;
  /** Public HMAC-signed verification code (see passport-code.ts). */
  passportCode: string;
  codeNonce: string;
  /** Full HMAC-SHA256 hex signature over the canonical code payload. */
  codeSignature: string;
  status: CreditPassportStatus;
  issuedBy: string;
  issuedAt: string;
  revokedAt?: string;
}

export interface CreditPassportDisclosure {
  id: string;
  credentialId: string;
  userId: string;
  /** Partner organisation / client id the credential is disclosed to. */
  disclosedTo: string;
  /** Scope the disclosure satisfies (e.g. 'credit-passport:read'). */
  scope: string;
  consentRecordedAt: string;
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
}

/* ------------------------------------------------------------------------ */
/* Hash-chain scheme (mirrors livestock-passport / traceability)             */
/* ------------------------------------------------------------------------ */

/**
 * The exact payload the hash covers. `payload` is canonicalised through the
 * shared canonicalJson (sorted keys, undefined dropped) so writer and
 * verifier agree byte-for-byte. The credential id, code material and
 * timestamps are deliberately NOT hashed: they are storage metadata, while
 * the chain protects the passport facts.
 */
export interface CredentialHashPayload {
  userId: string;
  version: number;
  payload: CreditPassportPayload;
  prevHash: string;
}

export function credentialHashPayloadOf(
  credential: Pick<CreditPassportCredential, 'userId' | 'version' | 'payload' | 'prevHash'>
): CredentialHashPayload {
  return {
    userId: credential.userId,
    version: credential.version,
    payload: credential.payload,
    prevHash: credential.prevHash
  };
}

/** sha256 hex over the canonical JSON of the hash payload. */
export function computeCredentialHash(payload: CredentialHashPayload): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

export interface CredentialVerification {
  credentialId: string;
  userId: string;
  version: number;
  status: CreditPassportStatus;
  /** Recomputed hash equals the stored payload_hash. */
  hashValid: boolean;
  /** Stored prev_hash equals the previous version's hash (or genesis). */
  prevLinkValid: boolean;
  valid: boolean;
  expectedHash: string;
  storedHash: string;
}

export interface CredentialChainVerification {
  userId: string;
  versionCount: number;
  valid: boolean;
  /** Hash of the chain head (undefined for an empty chain). */
  headHash?: string;
  versions: CredentialVerification[];
}

/**
 * Recomputes a farmer's credential chain from the stored versions
 * (ascending version). Detects both payload tampering (hash mismatch) and
 * chain surgery (prev-link mismatch, version gaps).
 */
export function verifyCredentialChain(
  userId: string,
  credentials: readonly CreditPassportCredential[]
): CredentialChainVerification {
  const ordered = [...credentials].sort((a, b) => a.version - b.version);
  const results: CredentialVerification[] = [];
  let expectedPrev = GENESIS_PREV_HASH;
  let expectedVersion = 1;
  for (const credential of ordered) {
    const expectedHash = computeCredentialHash(credentialHashPayloadOf(credential));
    const hashValid = expectedHash === credential.payloadHash;
    const prevLinkValid =
      credential.prevHash === expectedPrev && credential.version === expectedVersion;
    results.push({
      credentialId: credential.id,
      userId: credential.userId,
      version: credential.version,
      status: credential.status,
      hashValid,
      prevLinkValid,
      valid: hashValid && prevLinkValid,
      expectedHash,
      storedHash: credential.payloadHash
    });
    expectedPrev = credential.payloadHash;
    expectedVersion = credential.version + 1;
  }
  return {
    userId,
    versionCount: ordered.length,
    valid: results.every((result) => result.valid),
    headHash: ordered.length > 0 ? ordered[ordered.length - 1].payloadHash : undefined,
    versions: results
  };
}

export { GENESIS_PREV_HASH };
