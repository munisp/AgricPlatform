/**
 * Africa Livestock Trust Platform (ALTP) domain primitives — wave L1b.
 * Animal-health ledger (vet-signed vaccination/treatment records), movement
 * traceability (chain-of-custody log + state movement permits), recalls and
 * disease surveillance, plus the deterministic trust-grade rubric.
 *
 * Money is integer kobo elsewhere on the platform; this wave has no money
 * fields. All timestamps are ISO-8601 strings.
 */
import type { LivestockSpecies } from './livestock.js';

export const HEALTH_RECORD_TYPES = ['vaccination', 'treatment'] as const;
export type HealthRecordType = (typeof HEALTH_RECORD_TYPES)[number];

export const MOVEMENT_TRANSPORT_MODES = ['trek', 'truck', 'rail', 'boat', 'air'] as const;
export type MovementTransportMode = (typeof MOVEMENT_TRANSPORT_MODES)[number];

export const MOVEMENT_PURPOSES = [
  'sale',
  'grazing',
  'market',
  'slaughter',
  'breeding',
  'quarantine',
  'other'
] as const;
export type MovementPurpose = (typeof MOVEMENT_PURPOSES)[number];

export const PERMIT_STATUSES = ['issued', 'revoked'] as const;
export type PermitStatus = (typeof PERMIT_STATUSES)[number];

/** Computed permit verification outcomes (never stored). */
export const PERMIT_VERIFICATIONS = ['valid', 'revoked', 'expired'] as const;
export type PermitVerification = (typeof PERMIT_VERIFICATIONS)[number];

export const RECALL_SCOPES = ['animal', 'lot', 'owner', 'region'] as const;
export type RecallScope = (typeof RECALL_SCOPES)[number];

export const RECALL_STATUSES = ['initiated', 'notified', 'resolved'] as const;
export type RecallStatus = (typeof RECALL_STATUSES)[number];

export const DISEASE_FLAG_STATUSES = ['reported', 'confirmed', 'retracted'] as const;
export type DiseaseFlagStatus = (typeof DISEASE_FLAG_STATUSES)[number];

export const ANIMAL_GRADES = ['A', 'B', 'C', 'D'] as const;
export type AnimalGrade = (typeof ANIMAL_GRADES)[number];

/**
 * Core vaccination schedule per species (blueprint F2/F5.2 — coverage is
 * scored against this list). A vaccination health record counts towards
 * coverage when its `product` matches a schedule entry (case-insensitive).
 */
export const VACCINATION_SCHEDULES: Record<LivestockSpecies, readonly string[]> = {
  cattle: ['FMD', 'CBPP', 'Anthrax'],
  sheep: ['PPR', 'Sheep Pox'],
  goat: ['PPR', 'CCPP'],
  chicken: ['Newcastle', 'Gumboro', 'Fowl Pox'],
  pig: ['CSF', 'FMD']
};

/**
 * Vet-signed health ledger entry (vaccination or treatment). Append-only:
 * corrections are new records whose `reversalOfId` points at the record they
 * annul; records are never updated or deleted. `signature` is an HMAC-SHA256
 * (base64url) over the canonical payload — see canonicalHealthRecordPayload.
 */
export interface AnimalHealthRecord {
  id: string;
  animalId: string;
  recordType: HealthRecordType;
  /** Vaccine or drug name (matched against VACCINATION_SCHEDULES for grading). */
  product: string;
  batchNumber: string;
  dose: string;
  administeredAt: string;
  /** Food-safety withdrawal window end (meat/milk) for treatments. */
  withdrawalUntil?: string;
  /** Veterinarian who administered and signed the record. */
  vetUserId: string;
  notes?: string;
  /** HMAC-SHA256 signature over the canonical payload (base64url). */
  signature: string;
  /** Instant the signature was issued; part of the signed payload. */
  signedAt: string;
  /** Set on reversing entries: id of the ledger record this entry annuls. */
  reversalOfId?: string;
  createdAt: string;
}

/** Fields covered by the vet HMAC signature, in canonical order. */
export interface HealthRecordSignaturePayload {
  animalId: string;
  recordType: HealthRecordType;
  product: string;
  batchNumber: string;
  dose: string;
  administeredAt: string;
  vetUserId: string;
  signedAt: string;
}

export const HEALTH_RECORD_SIGNATURE_VERSION = 'v1';

/**
 * Canonical signing payload for a health record: version-prefixed,
 * pipe-joined fields in a fixed order (vet identity + signing timestamp +
 * animal + product/batch/dose). Any field tamper changes the digest.
 */
export function canonicalHealthRecordPayload(payload: HealthRecordSignaturePayload): string {
  return [
    HEALTH_RECORD_SIGNATURE_VERSION,
    payload.animalId,
    payload.recordType,
    payload.product,
    payload.batchNumber,
    payload.dose,
    payload.administeredAt,
    payload.vetUserId,
    payload.signedAt
  ].join('|');
}

/**
 * Chain-of-custody movement log entry for one animal or one lot (exactly one
 * of animalId/lotId is set). A movement is OPEN until `arrivedAt` is
 * recorded; an animal/lot with an open movement cannot start another.
 */
export interface AnimalMovement {
  id: string;
  animalId?: string;
  lotId?: string;
  fromState: string;
  fromLga?: string;
  toState: string;
  toLga?: string;
  departedAt: string;
  arrivedAt?: string;
  transportMode: MovementTransportMode;
  purpose: MovementPurpose;
  permitId?: string;
  recordedBy: string;
  createdAt: string;
}

/** State movement permit referencing animals and/or lots (blueprint F4.3). */
export interface MovementPermit {
  id: string;
  /** Human-facing permit number, e.g. PMT-KD-LA-3F9A2C71. */
  permitNumber: string;
  fromState: string;
  toState: string;
  validFrom: string;
  validUntil: string;
  status: PermitStatus;
  issuedBy: string;
  revokedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export type PermitSubjectType = 'animal' | 'lot';

export interface PermitSubject {
  permitId: string;
  subjectType: PermitSubjectType;
  subjectId: string;
}

/**
 * Recall case (blueprint F4.2 — traceback within a 24-hour window). The scope
 * fields mirror the four supported scopes; exactly one of animalId / lotId /
 * ownerUserId / state(+date range) is set. Affected animals are materialised
 * in livestock.recall_animals at initiation so the case is auditable even as
 * lots and ownership change afterwards.
 */
export interface LivestockRecall {
  id: string;
  scope: RecallScope;
  animalId?: string;
  lotId?: string;
  ownerUserId?: string;
  state?: string;
  fromDate?: string;
  toDate?: string;
  /** Optional product-batch filter (matches health-record batch numbers). */
  batchNumber?: string;
  reason: string;
  status: RecallStatus;
  initiatedBy: string;
  createdAt: string;
  notifiedAt?: string;
  resolvedAt?: string;
}

/** Animal materialised into a recall case, with the owner captured for notification. */
export interface RecallAnimal {
  recallId: string;
  animalId: string;
  ownerUserId: string;
}

/**
 * Disease surveillance flag (blueprint F5.1/F5.4). Lifecycle:
 * reported → confirmed (vet/regulator) or → retracted (false-positive
 * handling; retraction always records a reason).
 */
export interface DiseaseFlag {
  id: string;
  disease: string;
  state: string;
  lga?: string;
  suspectedSpecies?: LivestockSpecies;
  reporterUserId: string;
  status: DiseaseFlagStatus;
  confirmedBy?: string;
  retractedReason?: string;
  createdAt: string;
  updatedAt: string;
}

/** State-level disease-map feed row (confirmed flags grouped by state+disease). */
export interface DiseaseMapEntry {
  state: string;
  disease: string;
  confirmedFlags: number;
  latestReportedAt: string;
}

/* ---------------------------------------------------------------------------
 * Vaccination due computation (wave MOB — mobile/web dashboard).
 *
 * There is deliberately no separate schedule table: the append-only health
 * ledger is the source of truth, and a vaccination's due date is derived as
 * `lastAdministeredAt + interval` per scheduled vaccine (intervals below).
 * An animal with no effective vaccination record for a scheduled vaccine is
 * due from its registration date.
 */

/**
 * Booster interval in days per scheduled vaccine (matched case-insensitively
 * against AnimalHealthRecord.product). Values follow common Nigerian
 * veterinary practice: FMD is re-administered every ~6 months in endemic
 * zones, Newcastle (I-2 thermostable) every ~4 months in village poultry,
 * and the remaining core vaccines annually.
 */
export const VACCINATION_INTERVAL_DAYS: Record<string, number> = {
  FMD: 180,
  CBPP: 365,
  Anthrax: 365,
  PPR: 365,
  'Sheep Pox': 365,
  CCPP: 365,
  Newcastle: 120,
  Gumboro: 365,
  'Fowl Pox': 365,
  CSF: 365
};

/** Interval applied when a vaccine has no entry in VACCINATION_INTERVAL_DAYS. */
export const DEFAULT_VACCINATION_INTERVAL_DAYS = 365;

export const VACCINATION_DUE_STATUSES = ['overdue', 'due', 'upcoming'] as const;
export type VaccinationDueStatus = (typeof VACCINATION_DUE_STATUSES)[number];

/**
 * One computed due-vaccination row (GET /livestock-health/vaccinations/due).
 * `daysOverdue` is set only when status is 'overdue'; `daysUntilDue` only
 * when status is 'due' or 'upcoming' ('due' means due within the requested
 * window, 'upcoming' beyond it). `lastAdministeredAt` is absent when the
 * animal has no effective vaccination record for the vaccine.
 */
export interface VaccinationDueItem {
  animalId: string;
  vaccine: string;
  /** ISO-8601 instant the vaccination is/was due. */
  dueDate: string;
  lastAdministeredAt?: string;
  daysOverdue?: number;
  daysUntilDue?: number;
  status: VaccinationDueStatus;
}
