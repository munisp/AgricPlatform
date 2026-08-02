import type pg from 'pg';
import type {
  AggregationPoint,
  CertifiedListing,
  ColdChainLog,
  DonorDisbursement,
  ExportDocument,
  ExportDocumentType,
  InsuranceClaim,
  InsurancePolicy,
  LivestockLien,
  LivestockSubjectType,
  OfftakeContract,
  OfftakeTemplate
} from '@agric-platform/shared';
import {
  composeWhere,
  eq,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import {
  aggregationPointMapper,
  certifiedListingMapper,
  coldChainLogMapper,
  disbursementMapper,
  exportDocumentMapper,
  insuranceClaimMapper,
  insurancePolicyMapper,
  lienMapper,
  offtakeContractMapper,
  offtakeTemplateMapper
} from '../pg/row-mappers.js';
import type {
  AggregationPointCriteria,
  AggregationPointRepository,
  CertifiedListingCriteria,
  CertifiedListingRepository,
  ColdChainLogCriteria,
  ColdChainLogRepository,
  DisbursementCriteria,
  DisbursementRepository,
  ExportDocumentCriteria,
  ExportDocumentRepository,
  InsuranceClaimCriteria,
  InsuranceClaimRepository,
  InsurancePolicyCriteria,
  InsurancePolicyRepository,
  LienCriteria,
  LienRepository,
  OfftakeContractCriteria,
  OfftakeContractRepository,
  OfftakeTemplateCriteria,
  OfftakeTemplateRepository
} from './livestock-trade.repository.js';

/**
 * ALTP livestock trade/finance pg implementations (wave L1c, livestock
 * schema). Every table uses an `id` primary key, so the base id-keyed
 * methods apply directly; uniqueness rules (one active lien, recall claim
 * de-dup, disbursement triple, export-document version) are enforced by
 * database constraints and surface through mapPgError as 409s.
 */

export function certifiedListingCriteriaSql(criteria: CertifiedListingCriteria): WhereClause {
  return composeWhere(
    eq('seller_user_id', criteria.sellerUserId),
    eq('status', criteria.status),
    eq('subject_type', criteria.subjectType),
    eq('subject_id', criteria.subjectId)
  );
}

export class PgCertifiedListingRepository
  extends PgRepositoryBase<CertifiedListing, CertifiedListingCriteria>
  implements CertifiedListingRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.certified_listings',
      mapper: certifiedListingMapper,
      criteria: certifiedListingCriteriaSql
    });
  }
}

export function createPgCertifiedListingRepository(pool: pg.Pool): PgCertifiedListingRepository {
  return new PgCertifiedListingRepository(pool);
}

// ---------------------------------------------------------------------------

export function offtakeTemplateCriteriaSql(criteria: OfftakeTemplateCriteria): WhereClause {
  return composeWhere(
    eq('status', criteria.status),
    eq('species', criteria.species),
    eq('created_by_user_id', criteria.createdByUserId)
  );
}

export class PgOfftakeTemplateRepository
  extends PgRepositoryBase<OfftakeTemplate, OfftakeTemplateCriteria>
  implements OfftakeTemplateRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.offtake_templates',
      mapper: offtakeTemplateMapper,
      criteria: offtakeTemplateCriteriaSql
    });
  }
}

export function createPgOfftakeTemplateRepository(pool: pg.Pool): PgOfftakeTemplateRepository {
  return new PgOfftakeTemplateRepository(pool);
}

// ---------------------------------------------------------------------------

export function offtakeContractCriteriaSql(criteria: OfftakeContractCriteria): WhereClause {
  return composeWhere(
    eq('template_id', criteria.templateId),
    eq('farmer_user_id', criteria.farmerUserId),
    eq('buyer_user_id', criteria.buyerUserId),
    eq('status', criteria.status)
  );
}

export class PgOfftakeContractRepository
  extends PgRepositoryBase<OfftakeContract, OfftakeContractCriteria>
  implements OfftakeContractRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.offtake_contracts',
      mapper: offtakeContractMapper,
      criteria: offtakeContractCriteriaSql
    });
  }
}

export function createPgOfftakeContractRepository(pool: pg.Pool): PgOfftakeContractRepository {
  return new PgOfftakeContractRepository(pool);
}

// ---------------------------------------------------------------------------

export function exportDocumentCriteriaSql(criteria: ExportDocumentCriteria): WhereClause {
  return composeWhere(
    eq('document_type', criteria.documentType),
    eq('subject_type', criteria.subjectType),
    eq('subject_id', criteria.subjectId),
    eq('created_by_user_id', criteria.createdByUserId)
  );
}

export class PgExportDocumentRepository
  extends PgRepositoryBase<ExportDocument, ExportDocumentCriteria>
  implements ExportDocumentRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.export_documents',
      mapper: exportDocumentMapper,
      criteria: exportDocumentCriteriaSql
    });
  }

  async nextVersion(
    documentType: ExportDocumentType,
    subjectType: LivestockSubjectType,
    subjectId: string
  ): Promise<number> {
    const result = await this.pool.query(
      `SELECT coalesce(max(version), 0)::int AS max_version FROM livestock.export_documents
       WHERE document_type = $1 AND subject_type = $2 AND subject_id = $3`,
      [documentType, subjectType, subjectId]
    );
    return (result.rows[0].max_version as number) + 1;
  }
}

export function createPgExportDocumentRepository(pool: pg.Pool): PgExportDocumentRepository {
  return new PgExportDocumentRepository(pool);
}

// ---------------------------------------------------------------------------

export function lienCriteriaSql(criteria: LienCriteria): WhereClause {
  return composeWhere(
    eq('subject_type', criteria.subjectType),
    eq('subject_id', criteria.subjectId),
    eq('lender_user_id', criteria.lenderUserId),
    eq('borrower_user_id', criteria.borrowerUserId),
    eq('status', criteria.status)
  );
}

export class PgLienRepository
  extends PgRepositoryBase<LivestockLien, LienCriteria>
  implements LienRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.liens',
      mapper: lienMapper,
      criteria: lienCriteriaSql
    });
  }

  async findActiveForSubject(
    subjectType: LivestockSubjectType,
    subjectId: string
  ): Promise<LivestockLien | undefined> {
    return this.findOne({ subjectType, subjectId, status: 'active' });
  }
}

export function createPgLienRepository(pool: pg.Pool): PgLienRepository {
  return new PgLienRepository(pool);
}

// ---------------------------------------------------------------------------

export function insurancePolicyCriteriaSql(criteria: InsurancePolicyCriteria): WhereClause {
  return composeWhere(
    eq('holder_user_id', criteria.holderUserId),
    eq('insurer_user_id', criteria.insurerUserId),
    eq('subject_type', criteria.subjectType),
    eq('subject_id', criteria.subjectId),
    eq('status', criteria.status)
  );
}

export class PgInsurancePolicyRepository
  extends PgRepositoryBase<InsurancePolicy, InsurancePolicyCriteria>
  implements InsurancePolicyRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.insurance_policies',
      mapper: insurancePolicyMapper,
      criteria: insurancePolicyCriteriaSql
    });
  }
}

export function createPgInsurancePolicyRepository(pool: pg.Pool): PgInsurancePolicyRepository {
  return new PgInsurancePolicyRepository(pool);
}

// ---------------------------------------------------------------------------

export function insuranceClaimCriteriaSql(criteria: InsuranceClaimCriteria): WhereClause {
  return composeWhere(
    eq('policy_id', criteria.policyId),
    eq('claimant_user_id', criteria.claimantUserId),
    eq('status', criteria.status),
    eq('recall_id', criteria.recallId)
  );
}

export class PgInsuranceClaimRepository
  extends PgRepositoryBase<InsuranceClaim, InsuranceClaimCriteria>
  implements InsuranceClaimRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.insurance_claims',
      mapper: insuranceClaimMapper,
      criteria: insuranceClaimCriteriaSql
    });
  }
}

export function createPgInsuranceClaimRepository(pool: pg.Pool): PgInsuranceClaimRepository {
  return new PgInsuranceClaimRepository(pool);
}

// ---------------------------------------------------------------------------

export function disbursementCriteriaSql(criteria: DisbursementCriteria): WhereClause {
  return composeWhere(
    eq('donor_user_id', criteria.donorUserId),
    eq('programme_id', criteria.programmeId),
    eq('milestone', criteria.milestone),
    eq('beneficiary_user_id', criteria.beneficiaryUserId),
    eq('status', criteria.status)
  );
}

export class PgDisbursementRepository
  extends PgRepositoryBase<DonorDisbursement, DisbursementCriteria>
  implements DisbursementRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.disbursements',
      mapper: disbursementMapper,
      criteria: disbursementCriteriaSql
    });
  }
}

export function createPgDisbursementRepository(pool: pg.Pool): PgDisbursementRepository {
  return new PgDisbursementRepository(pool);
}

// ---------------------------------------------------------------------------

export function aggregationPointCriteriaSql(criteria: AggregationPointCriteria): WhereClause {
  return composeWhere(
    eq('manager_user_id', criteria.managerUserId),
    eq('state', criteria.state),
    eq('status', criteria.status)
  );
}

export class PgAggregationPointRepository
  extends PgRepositoryBase<AggregationPoint, AggregationPointCriteria>
  implements AggregationPointRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.aggregation_points',
      mapper: aggregationPointMapper,
      criteria: aggregationPointCriteriaSql
    });
  }
}

export function createPgAggregationPointRepository(pool: pg.Pool): PgAggregationPointRepository {
  return new PgAggregationPointRepository(pool);
}

// ---------------------------------------------------------------------------

export function coldChainLogCriteriaSql(criteria: ColdChainLogCriteria): WhereClause {
  return composeWhere(eq('point_id', criteria.pointId));
}

export class PgColdChainLogRepository
  extends PgRepositoryBase<ColdChainLog, ColdChainLogCriteria>
  implements ColdChainLogRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'livestock.cold_chain_logs',
      mapper: coldChainLogMapper,
      criteria: coldChainLogCriteriaSql,
      orderBy: 'recorded_at'
    });
  }
}

export function createPgColdChainLogRepository(pool: pg.Pool): PgColdChainLogRepository {
  return new PgColdChainLogRepository(pool);
}
