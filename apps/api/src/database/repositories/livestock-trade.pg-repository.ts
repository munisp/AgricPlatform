import type pg from 'pg';
import type {
  CertifiedListing,
  ExportDocument,
  OfftakeContract,
  OfftakeTemplate
} from '@agric-platform/shared';
import {
  composeWhere,
  eq,
  PgRepositoryBase,
  type RowMapper,
  type WhereClause
} from '../pg/pg-repository.base.js';
import type {
  CertifiedListingCriteria,
  CertifiedListingRepository,
  ExportDocumentCriteria,
  ExportDocumentRepository,
  OfftakeContractCriteria,
  OfftakeContractRepository,
  OfftakeTemplateCriteria,
  OfftakeTemplateRepository
} from './livestock-trade.repository.js';

/**
 * Livestock-trade pg implementations (livestock schema, migration 060
 * trade pack: livestock.certified_listings / offtake_templates /
 * offtake_contracts / export_documents). toRow only emits keys present on
 * the item so Partial<T> patches update exactly the patched columns
 * (present-but-undefined → SQL NULL = clearing; matches farms wave).
 */

function present<T extends object>(
  item: Partial<T>,
  mapping: Record<string, keyof Partial<T>>
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [column, key] of Object.entries(mapping)) {
    if (key in item) {
      const value = (item as Record<string, unknown>)[key as string];
      row[column] = value === undefined ? null : value;
    }
  }
  return row;
}

// ---------------------------------------------------------------------------
// livestock.certified_listings
// ---------------------------------------------------------------------------

const CERTIFIED_LISTING_MAPPING = {
  id: 'id',
  seller_user_id: 'sellerUserId',
  subject_type: 'subjectType',
  subject_id: 'subjectId',
  certification_id: 'certificationId',
  asking_price_kobo: 'askingPriceKobo',
  status: 'status',
  provenance: 'provenance',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  activated_at: 'activatedAt',
  sold_at: 'soldAt',
  withdrawn_at: 'withdrawnAt',
  revoked_at: 'revokedAt',
  revoked_reason: 'revokedReason'
} as const;

export const certifiedListingMapper: RowMapper<CertifiedListing> = {
  columns: Object.keys(CERTIFIED_LISTING_MAPPING),
  fromRow: (row) => ({
    id: row.id as string,
    sellerUserId: row.seller_user_id as string,
    subjectType: row.subject_type as CertifiedListing['subjectType'],
    subjectId: row.subject_id as string,
    certificationId: row.certification_id as string,
    askingPriceKobo:
      row.asking_price_kobo === null || row.asking_price_kobo === undefined
        ? undefined
        : Number(row.asking_price_kobo),
    status: row.status as CertifiedListing['status'],
    provenance: row.provenance as CertifiedListing['provenance'],
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
    activatedAt: row.activated_at ? new Date(row.activated_at as string).toISOString() : undefined,
    soldAt: row.sold_at ? new Date(row.sold_at as string).toISOString() : undefined,
    withdrawnAt: row.withdrawn_at ? new Date(row.withdrawn_at as string).toISOString() : undefined,
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string).toISOString() : undefined,
    revokedReason: (row.revoked_reason as string | null) ?? undefined
  }),
  toRow: (item) => {
    const row = present(item, CERTIFIED_LISTING_MAPPING);
    if ('provenance' in item && item.provenance !== undefined) {
      row.provenance = JSON.stringify(item.provenance);
    }
    return row;
  }
};

export function certifiedListingCriteriaSql(criteria: CertifiedListingCriteria): WhereClause {
  return composeWhere(
    eq('seller_user_id', criteria.sellerUserId),
    eq('subject_type', criteria.subjectType),
    eq('subject_id', criteria.subjectId),
    eq('status', criteria.status)
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
// livestock.offtake_templates
// ---------------------------------------------------------------------------

const OFFTAKE_TEMPLATE_MAPPING = {
  id: 'id',
  created_by_user_id: 'createdByUserId',
  name: 'name',
  description: 'description',
  species: 'species',
  default_quantity: 'defaultQuantity',
  default_price_per_unit_kobo: 'defaultPricePerUnitKobo',
  delivery_window_days: 'deliveryWindowDays',
  default_quality_grade: 'defaultQualityGrade',
  status: 'status',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  archived_at: 'archivedAt'
} as const;

export const offtakeTemplateMapper: RowMapper<OfftakeTemplate> = {
  columns: Object.keys(OFFTAKE_TEMPLATE_MAPPING),
  fromRow: (row) => ({
    id: row.id as string,
    createdByUserId: row.created_by_user_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? undefined,
    species: row.species as OfftakeTemplate['species'],
    defaultQuantity:
      row.default_quantity === null || row.default_quantity === undefined
        ? undefined
        : Number(row.default_quantity),
    defaultPricePerUnitKobo:
      row.default_price_per_unit_kobo === null || row.default_price_per_unit_kobo === undefined
        ? undefined
        : Number(row.default_price_per_unit_kobo),
    deliveryWindowDays: Number(row.delivery_window_days),
    defaultQualityGrade: (row.default_quality_grade as string | null) ?? undefined,
    status: row.status as OfftakeTemplate['status'],
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
    archivedAt: row.archived_at ? new Date(row.archived_at as string).toISOString() : undefined
  }),
  toRow: (item) => present(item, OFFTAKE_TEMPLATE_MAPPING)
};

export function offtakeTemplateCriteriaSql(criteria: OfftakeTemplateCriteria): WhereClause {
  return composeWhere(eq('status', criteria.status), eq('species', criteria.species));
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
// livestock.offtake_contracts
// ---------------------------------------------------------------------------

const OFFTAKE_CONTRACT_MAPPING = {
  id: 'id',
  template_id: 'templateId',
  farmer_user_id: 'farmerUserId',
  buyer_user_id: 'buyerUserId',
  species: 'species',
  quantity: 'quantity',
  price_per_unit_kobo: 'pricePerUnitKobo',
  delivery_window_start: 'deliveryWindowStart',
  delivery_window_end: 'deliveryWindowEnd',
  quality_grade: 'qualityGrade',
  status: 'status',
  terms_hash: 'termsHash',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  activated_at: 'activatedAt',
  fulfilled_at: 'fulfilledAt',
  breached_at: 'breachedAt',
  terminated_at: 'terminatedAt'
} as const;

export const offtakeContractMapper: RowMapper<OfftakeContract> = {
  columns: Object.keys(OFFTAKE_CONTRACT_MAPPING),
  fromRow: (row) => ({
    id: row.id as string,
    templateId: row.template_id as string,
    farmerUserId: row.farmer_user_id as string,
    buyerUserId: row.buyer_user_id as string,
    species: row.species as OfftakeContract['species'],
    quantity: Number(row.quantity),
    pricePerUnitKobo: Number(row.price_per_unit_kobo),
    deliveryWindowStart: new Date(row.delivery_window_start as string).toISOString(),
    deliveryWindowEnd: new Date(row.delivery_window_end as string).toISOString(),
    qualityGrade: (row.quality_grade as string | null) ?? undefined,
    status: row.status as OfftakeContract['status'],
    termsHash: row.terms_hash as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
    activatedAt: row.activated_at ? new Date(row.activated_at as string).toISOString() : undefined,
    fulfilledAt: row.fulfilled_at ? new Date(row.fulfilled_at as string).toISOString() : undefined,
    breachedAt: row.breached_at ? new Date(row.breached_at as string).toISOString() : undefined,
    terminatedAt: row.terminated_at ? new Date(row.terminated_at as string).toISOString() : undefined
  }),
  toRow: (item) => present(item, OFFTAKE_CONTRACT_MAPPING)
};

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
// livestock.export_documents
// ---------------------------------------------------------------------------

const EXPORT_DOCUMENT_MAPPING = {
  id: 'id',
  document_type: 'documentType',
  subject_type: 'subjectType',
  subject_id: 'subjectId',
  created_by_user_id: 'createdByUserId',
  version: 'version',
  payload: 'payload',
  destination_country: 'destinationCountry',
  hs_code: 'hsCode',
  sanitary_certificate_ref: 'sanitaryCertificateRef',
  created_at: 'createdAt'
} as const;

export const exportDocumentMapper: RowMapper<ExportDocument> = {
  columns: Object.keys(EXPORT_DOCUMENT_MAPPING),
  fromRow: (row) => ({
    id: row.id as string,
    documentType: row.document_type as ExportDocument['documentType'],
    subjectType: row.subject_type as ExportDocument['subjectType'],
    subjectId: row.subject_id as string,
    createdByUserId: row.created_by_user_id as string,
    version: Number(row.version),
    payload: row.payload as ExportDocument['payload'],
    destinationCountry: (row.destination_country as string | null) ?? undefined,
    hsCode: (row.hs_code as string | null) ?? undefined,
    sanitaryCertificateRef: (row.sanitary_certificate_ref as string | null) ?? undefined,
    createdAt: new Date(row.created_at as string).toISOString()
  }),
  toRow: (item) => {
    const row = present(item, EXPORT_DOCUMENT_MAPPING);
    if ('payload' in item && item.payload !== undefined) {
      row.payload = JSON.stringify(item.payload);
    }
    return row;
  }
};

export function exportDocumentCriteriaSql(criteria: ExportDocumentCriteria): WhereClause {
  return composeWhere(
    eq('subject_type', criteria.subjectType),
    eq('subject_id', criteria.subjectId),
    eq('document_type', criteria.documentType),
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
      criteria: exportDocumentCriteriaSql,
      orderBy: 'created_at DESC'
    });
  }

  async maxVersion(
    subjectType: ExportDocument['subjectType'],
    subjectId: string,
    documentType: ExportDocument['documentType']
  ): Promise<number> {
    const rows = await this.find({ subjectType, subjectId, documentType });
    return rows.reduce((max, row) => Math.max(max, row.version), 0);
  }
}

export function createPgExportDocumentRepository(pool: pg.Pool): PgExportDocumentRepository {
  return new PgExportDocumentRepository(pool);
}
