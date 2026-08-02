/**
 * Africa Livestock Trust Platform (ALTP) domain primitives — wave L1c.
 * Certified trade (F4), livestock finance (F5), regulator compliance (F6)
 * and partner aggregation (F7). Money is integer kobo throughout; all
 * timestamps are ISO strings.
 */

/** A registry subject a trade/finance record can reference. */
export const LIVESTOCK_SUBJECT_TYPES = ['animal', 'lot'] as const;
export type LivestockSubjectType = (typeof LIVESTOCK_SUBJECT_TYPES)[number];

// ---------------------------------------------------------------------------
// F4 — certified listings.

export const CERTIFIED_LISTING_STATUSES = [
  'draft',
  'active',
  'sold',
  'withdrawn',
  'revoked'
] as const;
export type CertifiedListingStatus = (typeof CERTIFIED_LISTING_STATUSES)[number];

/** Provenance snapshot captured at certification time. */
export interface ListingProvenance {
  subjectType: LivestockSubjectType;
  subjectId: string;
  species: string;
  breed?: string;
  /** Number of recorded ownership transfers for the subject (0 for lots). */
  ownershipDepth: number;
  /** livestock_records consent state of the owner at certification time. */
  consentGranted: boolean;
}

export interface CertifiedListing {
  id: string;
  subjectType: LivestockSubjectType;
  subjectId: string;
  /** Owner who certified the subject (only the owner may certify). */
  sellerUserId: string;
  species: string;
  breed?: string;
  /** Lot size when the subject is a lot. */
  quantity?: number;
  askingPriceKobo?: number;
  status: CertifiedListingStatus;
  provenance: ListingProvenance;
  revokedByUserId?: string;
  revokedAt?: string;
  revocationReason?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// F4 — off-take contract templates and contracts.

export const OFFTAKE_TEMPLATE_STATUSES = ['active', 'archived'] as const;
export type OfftakeTemplateStatus = (typeof OFFTAKE_TEMPLATE_STATUSES)[number];

export const OFFTAKE_CONTRACT_STATUSES = [
  'draft',
  'active',
  'fulfilled',
  'breached',
  'terminated'
] as const;
export type OfftakeContractStatus = (typeof OFFTAKE_CONTRACT_STATUSES)[number];

/**
 * Partner/admin-managed contract template. The variable slots (quantity,
 * pricePerUnitKobo, delivery window, quality grade) may carry defaults that
 * instantiation can override.
 */
export interface OfftakeTemplate {
  id: string;
  name: string;
  description?: string;
  species: string;
  defaultQuantity?: number;
  defaultPricePerUnitKobo?: number;
  /** Default delivery window length in days from contract activation. */
  deliveryWindowDays: number;
  defaultQualityGrade?: string;
  status: OfftakeTemplateStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface OfftakeContract {
  id: string;
  templateId: string;
  farmerUserId: string;
  buyerUserId: string;
  species: string;
  quantity: number;
  pricePerUnitKobo: number;
  /** quantity × pricePerUnitKobo (integer kobo, computed at instantiation). */
  totalKobo: number;
  deliveryWindowStart: string;
  deliveryWindowEnd: string;
  qualityGrade?: string;
  status: OfftakeContractStatus;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// F4 — AfCFTA / cross-border export documents (DRAFT payloads only).

export const EXPORT_DOCUMENT_TYPES = [
  'certificate_of_origin',
  'sanitary_certificate',
  'consignment_note'
] as const;
export type ExportDocumentType = (typeof EXPORT_DOCUMENT_TYPES)[number];

/** Every generated payload carries this watermark; nothing is submitted. */
export const EXPORT_DOCUMENT_WATERMARK =
  'DRAFT — generated for review only; not submitted to any authority';

export interface ExportConsignment {
  subjectType: LivestockSubjectType;
  subjectId: string;
  species: string;
  breed?: string;
  quantity: number;
  originState: string;
  originLga?: string;
  ownerUserId: string;
}

export interface ExportDocumentPayload {
  watermark: typeof EXPORT_DOCUMENT_WATERMARK;
  documentType: ExportDocumentType;
  version: number;
  consignment: ExportConsignment;
  certificateOfOrigin: {
    originCountry: 'Nigeria';
    exporterUserId: string;
    destinationCountry?: string;
    hsCode?: string;
  };
  /** Placeholder reference until a sanitary certificate authority integrates. */
  sanitaryCertificateRef?: string;
  generatedAt: string;
}

export interface ExportDocument {
  id: string;
  documentType: ExportDocumentType;
  subjectType: LivestockSubjectType;
  subjectId: string;
  /** 1-based version per (documentType, subject); increments on regenerate. */
  version: number;
  status: 'draft';
  payload: ExportDocumentPayload;
  createdByUserId: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// F5 — liens.

export const LIEN_STATUSES = ['active', 'discharged', 'defaulted'] as const;
export type LienStatus = (typeof LIEN_STATUSES)[number];

export interface LivestockLien {
  id: string;
  subjectType: LivestockSubjectType;
  subjectId: string;
  lenderUserId: string;
  /** Subject owner at registration time (the borrower). */
  borrowerUserId: string;
  principalKobo: number;
  terms: string;
  status: LienStatus;
  registeredAt: string;
  dischargedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// F5 — insurance.

export const INSURANCE_POLICY_STATUSES = ['quote', 'bound', 'lapsed', 'cancelled'] as const;
export type InsurancePolicyStatus = (typeof INSURANCE_POLICY_STATUSES)[number];

export interface InsurancePolicy {
  id: string;
  holderUserId: string;
  insurerUserId?: string;
  subjectType: LivestockSubjectType;
  subjectId: string;
  species: string;
  premiumKobo: number;
  coverageKobo: number;
  status: InsurancePolicyStatus;
  startsAt?: string;
  endsAt?: string;
  createdAt: string;
  updatedAt: string;
}

export const INSURANCE_CLAIM_STATUSES = [
  'draft',
  'submitted',
  'assessed',
  'paid',
  'rejected'
] as const;
export type InsuranceClaimStatus = (typeof INSURANCE_CLAIM_STATUSES)[number];

export const INSURANCE_CLAIM_TRIGGERS = ['manual', 'recall'] as const;
export type InsuranceClaimTrigger = (typeof INSURANCE_CLAIM_TRIGGERS)[number];

export interface InsuranceClaim {
  id: string;
  policyId: string;
  claimantUserId: string;
  trigger: InsuranceClaimTrigger;
  recallId?: string;
  animalIds: string[];
  amountKobo?: number;
  status: InsuranceClaimStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Event payload published by the L1b health/recall wave. The insurance
 * subscriber tolerates the event arriving before L1b lands (it simply
 * never fires) and guards every lookup with existence checks.
 */
export const LIVESTOCK_RECALL_INITIATED_EVENT = 'livestock.recall.initiated';
export interface LivestockRecallInitiatedPayload {
  recallId: string;
  animalIds: string[];
}

// ---------------------------------------------------------------------------
// F6/F5 — donor disbursements.

export const DISBURSEMENT_MILESTONES = ['enrolment', 'registration', 'vaccination'] as const;
export type DisbursementMilestone = (typeof DISBURSEMENT_MILESTONES)[number];

export const DISBURSEMENT_STATUSES = ['scheduled', 'released', 'confirmed'] as const;
export type DisbursementStatus = (typeof DISBURSEMENT_STATUSES)[number];

export interface DonorDisbursement {
  id: string;
  donorUserId: string;
  programmeId: string;
  milestone: DisbursementMilestone;
  amountKobo: number;
  beneficiaryUserId: string;
  status: DisbursementStatus;
  releasedAt?: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// F7 — aggregation points.

export const AGGREGATION_POINT_STATUSES = ['active', 'inactive'] as const;
export type AggregationPointStatus = (typeof AGGREGATION_POINT_STATUSES)[number];

export interface AggregationPoint {
  id: string;
  name: string;
  state: string;
  lga: string;
  managerUserId: string;
  /** Maximum total headcount (sum of assigned lot quantities); optional. */
  capacity?: number;
  /** Lots currently assigned to the point (single-species enforced). */
  lotIds: string[];
  status: AggregationPointStatus;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Cold-chain telemetry (contract-only wave; provider stub fails closed).

export interface ColdChainLog {
  id: string;
  pointId: string;
  recordedAt: string;
  temperatureCelsius: number;
  humidityPercent?: number;
  /** Provider key that accepted the reading (e.g. 'stub', future vendor id). */
  source: string;
  createdAt: string;
}
