import { ConflictException } from '@nestjs/common';
import type {
  AggregationPoint,
  AggregationPointStatus,
  CertifiedListing,
  CertifiedListingStatus,
  ColdChainLog,
  DisbursementMilestone,
  DisbursementStatus,
  DonorDisbursement,
  ExportDocument,
  ExportDocumentType,
  InsuranceClaim,
  InsuranceClaimStatus,
  InsurancePolicy,
  InsurancePolicyStatus,
  LienStatus,
  LivestockLien,
  LivestockSubjectType,
  OfftakeContract,
  OfftakeContractStatus,
  OfftakeTemplate,
  OfftakeTemplateStatus
} from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/**
 * ALTP livestock trade/finance persistence ports (wave L1c,
 * infra/postgres/014). The in-memory implementations mirror the pg
 * semantics (uniqueness rules, one-active-lien, recall claim
 * de-duplication, disbursement idempotency) so unit tests keep full
 * fidelity.
 */

// ---------------------------------------------------------------------------
// Certified listings.

export interface CertifiedListingCriteria {
  sellerUserId?: string;
  status?: CertifiedListingStatus;
  subjectType?: LivestockSubjectType;
  subjectId?: string;
}

export interface CertifiedListingRepository
  extends AsyncRepository<CertifiedListing, CertifiedListingCriteria> {}

export function certifiedListingMatcher(
  criteria: CertifiedListingCriteria
): (listing: CertifiedListing) => boolean {
  return (listing) =>
    (!criteria.sellerUserId || listing.sellerUserId === criteria.sellerUserId) &&
    (!criteria.status || listing.status === criteria.status) &&
    (!criteria.subjectType || listing.subjectType === criteria.subjectType) &&
    (!criteria.subjectId || listing.subjectId === criteria.subjectId);
}

export class InMemoryCertifiedListingRepository
  extends InMemoryRepository<CertifiedListing, CertifiedListingCriteria>
  implements CertifiedListingRepository
{
  constructor(seed: readonly CertifiedListing[] = []) {
    super(seed, certifiedListingMatcher);
  }
}

export function createInMemoryCertifiedListingRepository(
  seed: readonly CertifiedListing[] = []
): InMemoryCertifiedListingRepository {
  return new InMemoryCertifiedListingRepository(seed);
}

// ---------------------------------------------------------------------------
// Off-take templates.

export interface OfftakeTemplateCriteria {
  status?: OfftakeTemplateStatus;
  species?: string;
  createdByUserId?: string;
}

export interface OfftakeTemplateRepository
  extends AsyncRepository<OfftakeTemplate, OfftakeTemplateCriteria> {}

export function offtakeTemplateMatcher(
  criteria: OfftakeTemplateCriteria
): (template: OfftakeTemplate) => boolean {
  return (template) =>
    (!criteria.status || template.status === criteria.status) &&
    (!criteria.species || template.species === criteria.species) &&
    (!criteria.createdByUserId || template.createdByUserId === criteria.createdByUserId);
}

export class InMemoryOfftakeTemplateRepository
  extends InMemoryRepository<OfftakeTemplate, OfftakeTemplateCriteria>
  implements OfftakeTemplateRepository
{
  constructor(seed: readonly OfftakeTemplate[] = []) {
    super(seed, offtakeTemplateMatcher);
  }
}

export function createInMemoryOfftakeTemplateRepository(
  seed: readonly OfftakeTemplate[] = []
): InMemoryOfftakeTemplateRepository {
  return new InMemoryOfftakeTemplateRepository(seed);
}

// ---------------------------------------------------------------------------
// Off-take contracts.

export interface OfftakeContractCriteria {
  templateId?: string;
  farmerUserId?: string;
  buyerUserId?: string;
  status?: OfftakeContractStatus;
}

export interface OfftakeContractRepository
  extends AsyncRepository<OfftakeContract, OfftakeContractCriteria> {}

export function offtakeContractMatcher(
  criteria: OfftakeContractCriteria
): (contract: OfftakeContract) => boolean {
  return (contract) =>
    (!criteria.templateId || contract.templateId === criteria.templateId) &&
    (!criteria.farmerUserId || contract.farmerUserId === criteria.farmerUserId) &&
    (!criteria.buyerUserId || contract.buyerUserId === criteria.buyerUserId) &&
    (!criteria.status || contract.status === criteria.status);
}

export class InMemoryOfftakeContractRepository
  extends InMemoryRepository<OfftakeContract, OfftakeContractCriteria>
  implements OfftakeContractRepository
{
  constructor(seed: readonly OfftakeContract[] = []) {
    super(seed, offtakeContractMatcher);
  }
}

export function createInMemoryOfftakeContractRepository(
  seed: readonly OfftakeContract[] = []
): InMemoryOfftakeContractRepository {
  return new InMemoryOfftakeContractRepository(seed);
}

// ---------------------------------------------------------------------------
// Export documents.

export interface ExportDocumentCriteria {
  documentType?: ExportDocumentType;
  subjectType?: LivestockSubjectType;
  subjectId?: string;
  createdByUserId?: string;
}

export interface ExportDocumentRepository
  extends AsyncRepository<ExportDocument, ExportDocumentCriteria> {
  /** Next 1-based version for (documentType, subjectType, subjectId). */
  nextVersion(
    documentType: ExportDocumentType,
    subjectType: LivestockSubjectType,
    subjectId: string
  ): Promise<number>;
}

export function exportDocumentMatcher(
  criteria: ExportDocumentCriteria
): (document: ExportDocument) => boolean {
  return (document) =>
    (!criteria.documentType || document.documentType === criteria.documentType) &&
    (!criteria.subjectType || document.subjectType === criteria.subjectType) &&
    (!criteria.subjectId || document.subjectId === criteria.subjectId) &&
    (!criteria.createdByUserId || document.createdByUserId === criteria.createdByUserId);
}

export class InMemoryExportDocumentRepository
  extends InMemoryRepository<ExportDocument, ExportDocumentCriteria>
  implements ExportDocumentRepository
{
  constructor(seed: readonly ExportDocument[] = []) {
    super(seed, exportDocumentMatcher);
  }

  async nextVersion(
    documentType: ExportDocumentType,
    subjectType: LivestockSubjectType,
    subjectId: string
  ): Promise<number> {
    const existing = await this.find({ documentType, subjectType, subjectId });
    return existing.reduce((max, doc) => Math.max(max, doc.version), 0) + 1;
  }

  override async create(item: ExportDocument): Promise<ExportDocument> {
    const clash = await this.find({
      documentType: item.documentType,
      subjectType: item.subjectType,
      subjectId: item.subjectId
    });
    if (clash.some((doc) => doc.version === item.version)) {
      throw new ConflictException(
        `Export document version ${item.version} already exists for ${item.subjectId}`
      );
    }
    return super.create(item);
  }
}

export function createInMemoryExportDocumentRepository(
  seed: readonly ExportDocument[] = []
): InMemoryExportDocumentRepository {
  return new InMemoryExportDocumentRepository(seed);
}

// ---------------------------------------------------------------------------
// Liens.

export interface LienCriteria {
  subjectType?: LivestockSubjectType;
  subjectId?: string;
  lenderUserId?: string;
  borrowerUserId?: string;
  status?: LienStatus;
}

export interface LienRepository extends AsyncRepository<LivestockLien, LienCriteria> {
  /** The active lien on a subject, when one exists (at most one allowed). */
  findActiveForSubject(
    subjectType: LivestockSubjectType,
    subjectId: string
  ): Promise<LivestockLien | undefined>;
}

export function lienMatcher(criteria: LienCriteria): (lien: LivestockLien) => boolean {
  return (lien) =>
    (!criteria.subjectType || lien.subjectType === criteria.subjectType) &&
    (!criteria.subjectId || lien.subjectId === criteria.subjectId) &&
    (!criteria.lenderUserId || lien.lenderUserId === criteria.lenderUserId) &&
    (!criteria.borrowerUserId || lien.borrowerUserId === criteria.borrowerUserId) &&
    (!criteria.status || lien.status === criteria.status);
}

export class InMemoryLienRepository
  extends InMemoryRepository<LivestockLien, LienCriteria>
  implements LienRepository
{
  constructor(seed: readonly LivestockLien[] = []) {
    super(seed, lienMatcher);
  }

  async findActiveForSubject(
    subjectType: LivestockSubjectType,
    subjectId: string
  ): Promise<LivestockLien | undefined> {
    return this.findOne({ subjectType, subjectId, status: 'active' });
  }

  override async create(item: LivestockLien): Promise<LivestockLien> {
    if (
      item.status === 'active' &&
      (await this.findActiveForSubject(item.subjectType, item.subjectId))
    ) {
      throw new ConflictException(
        `Subject '${item.subjectId}' already has an active lien`
      );
    }
    return super.create(item);
  }
}

export function createInMemoryLienRepository(
  seed: readonly LivestockLien[] = []
): InMemoryLienRepository {
  return new InMemoryLienRepository(seed);
}

/**
 * Transfer guard port consulted by LivestockService.transferAnimal before an
 * ownership transfer commits. Wired as an optional dependency so the
 * livestock core module never imports the trade module (no circular
 * dependency); the DatabaseModule binds the lien-backed implementation.
 *
 * ⚖ LEGAL ACTIVATION REQUIRED: blocking transfers on active liens has
 * secured-transaction implications under Nigerian law; do not activate in
 * production without qualified legal/regulatory review.
 */
export interface LivestockTransferGuard {
  /** Throws ConflictException when the animal may not change hands. */
  assertTransferable(animalId: string): Promise<void>;
}

/** Lien-backed guard: an animal with an active lien cannot be transferred. */
export function createLienTransferGuard(liens: LienRepository): LivestockTransferGuard {
  return {
    async assertTransferable(animalId: string): Promise<void> {
      const active = await liens.findActiveForSubject('animal', animalId);
      if (active) {
        throw new ConflictException(
          `Animal '${animalId}' has an active lien ('${active.id}') and cannot be transferred or sold`
        );
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Insurance policies.

export interface InsurancePolicyCriteria {
  holderUserId?: string;
  insurerUserId?: string;
  subjectType?: LivestockSubjectType;
  subjectId?: string;
  status?: InsurancePolicyStatus;
}

export interface InsurancePolicyRepository
  extends AsyncRepository<InsurancePolicy, InsurancePolicyCriteria> {}

export function insurancePolicyMatcher(
  criteria: InsurancePolicyCriteria
): (policy: InsurancePolicy) => boolean {
  return (policy) =>
    (!criteria.holderUserId || policy.holderUserId === criteria.holderUserId) &&
    (!criteria.insurerUserId || policy.insurerUserId === criteria.insurerUserId) &&
    (!criteria.subjectType || policy.subjectType === criteria.subjectType) &&
    (!criteria.subjectId || policy.subjectId === criteria.subjectId) &&
    (!criteria.status || policy.status === criteria.status);
}

export class InMemoryInsurancePolicyRepository
  extends InMemoryRepository<InsurancePolicy, InsurancePolicyCriteria>
  implements InsurancePolicyRepository
{
  constructor(seed: readonly InsurancePolicy[] = []) {
    super(seed, insurancePolicyMatcher);
  }
}

export function createInMemoryInsurancePolicyRepository(
  seed: readonly InsurancePolicy[] = []
): InMemoryInsurancePolicyRepository {
  return new InMemoryInsurancePolicyRepository(seed);
}

// ---------------------------------------------------------------------------
// Insurance claims.

export interface InsuranceClaimCriteria {
  policyId?: string;
  claimantUserId?: string;
  status?: InsuranceClaimStatus;
  recallId?: string;
}

export interface InsuranceClaimRepository
  extends AsyncRepository<InsuranceClaim, InsuranceClaimCriteria> {}

export function insuranceClaimMatcher(
  criteria: InsuranceClaimCriteria
): (claim: InsuranceClaim) => boolean {
  return (claim) =>
    (!criteria.policyId || claim.policyId === criteria.policyId) &&
    (!criteria.claimantUserId || claim.claimantUserId === criteria.claimantUserId) &&
    (!criteria.status || claim.status === criteria.status) &&
    (!criteria.recallId || claim.recallId === criteria.recallId);
}

export class InMemoryInsuranceClaimRepository
  extends InMemoryRepository<InsuranceClaim, InsuranceClaimCriteria>
  implements InsuranceClaimRepository
{
  constructor(seed: readonly InsuranceClaim[] = []) {
    super(seed, insuranceClaimMatcher);
  }

  /** Recall claims are idempotent per (policyId, recallId). */
  override async create(item: InsuranceClaim): Promise<InsuranceClaim> {
    if (item.recallId) {
      const existing = await this.findOne({ policyId: item.policyId, recallId: item.recallId });
      if (existing) {
        throw new ConflictException(
          `A recall claim for recall '${item.recallId}' already exists on policy '${item.policyId}'`
        );
      }
    }
    return super.create(item);
  }
}

export function createInMemoryInsuranceClaimRepository(
  seed: readonly InsuranceClaim[] = []
): InMemoryInsuranceClaimRepository {
  return new InMemoryInsuranceClaimRepository(seed);
}

// ---------------------------------------------------------------------------
// Donor disbursements.

export interface DisbursementCriteria {
  donorUserId?: string;
  programmeId?: string;
  milestone?: DisbursementMilestone;
  beneficiaryUserId?: string;
  status?: DisbursementStatus;
}

export interface DisbursementRepository
  extends AsyncRepository<DonorDisbursement, DisbursementCriteria> {}

export function disbursementMatcher(
  criteria: DisbursementCriteria
): (disbursement: DonorDisbursement) => boolean {
  return (disbursement) =>
    (!criteria.donorUserId || disbursement.donorUserId === criteria.donorUserId) &&
    (!criteria.programmeId || disbursement.programmeId === criteria.programmeId) &&
    (!criteria.milestone || disbursement.milestone === criteria.milestone) &&
    (!criteria.beneficiaryUserId ||
      disbursement.beneficiaryUserId === criteria.beneficiaryUserId) &&
    (!criteria.status || disbursement.status === criteria.status);
}

export class InMemoryDisbursementRepository
  extends InMemoryRepository<DonorDisbursement, DisbursementCriteria>
  implements DisbursementRepository
{
  constructor(seed: readonly DonorDisbursement[] = []) {
    super(seed, disbursementMatcher);
  }

  /** The (programme, milestone, beneficiary) triple is unique — a milestone
   * can never be scheduled (and therefore paid) twice for one beneficiary. */
  override async create(item: DonorDisbursement): Promise<DonorDisbursement> {
    const existing = await this.findOne({
      programmeId: item.programmeId,
      milestone: item.milestone,
      beneficiaryUserId: item.beneficiaryUserId
    });
    if (existing) {
      throw new ConflictException(
        `Disbursement for milestone '${item.milestone}' already exists for beneficiary '${item.beneficiaryUserId}' in programme '${item.programmeId}'`
      );
    }
    return super.create(item);
  }
}

export function createInMemoryDisbursementRepository(
  seed: readonly DonorDisbursement[] = []
): InMemoryDisbursementRepository {
  return new InMemoryDisbursementRepository(seed);
}

// ---------------------------------------------------------------------------
// Aggregation points.

export interface AggregationPointCriteria {
  managerUserId?: string;
  state?: string;
  status?: AggregationPointStatus;
}

export interface AggregationPointRepository
  extends AsyncRepository<AggregationPoint, AggregationPointCriteria> {}

export function aggregationPointMatcher(
  criteria: AggregationPointCriteria
): (point: AggregationPoint) => boolean {
  return (point) =>
    (!criteria.managerUserId || point.managerUserId === criteria.managerUserId) &&
    (!criteria.state || point.state === criteria.state) &&
    (!criteria.status || point.status === criteria.status);
}

export class InMemoryAggregationPointRepository
  extends InMemoryRepository<AggregationPoint, AggregationPointCriteria>
  implements AggregationPointRepository
{
  constructor(seed: readonly AggregationPoint[] = []) {
    super(seed, aggregationPointMatcher);
  }
}

export function createInMemoryAggregationPointRepository(
  seed: readonly AggregationPoint[] = []
): InMemoryAggregationPointRepository {
  return new InMemoryAggregationPointRepository(seed);
}

// ---------------------------------------------------------------------------
// Cold-chain logs.

export interface ColdChainLogCriteria {
  pointId?: string;
}

export interface ColdChainLogRepository
  extends AsyncRepository<ColdChainLog, ColdChainLogCriteria> {}

export function coldChainLogMatcher(
  criteria: ColdChainLogCriteria
): (log: ColdChainLog) => boolean {
  return (log) => !criteria.pointId || log.pointId === criteria.pointId;
}

export class InMemoryColdChainLogRepository
  extends InMemoryRepository<ColdChainLog, ColdChainLogCriteria>
  implements ColdChainLogRepository
{
  constructor(seed: readonly ColdChainLog[] = []) {
    super(seed, coldChainLogMatcher);
  }
}

export function createInMemoryColdChainLogRepository(
  seed: readonly ColdChainLog[] = []
): InMemoryColdChainLogRepository {
  return new InMemoryColdChainLogRepository(seed);
}
