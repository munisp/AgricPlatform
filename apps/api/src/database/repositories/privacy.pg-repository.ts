import type pg from 'pg';
import type { ConsentRecord } from '@agric-platform/shared';
import type { DeletionRequest } from '../seed-data.js';
import {
  composeWhere,
  eq,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import { consentMapper, deletionRequestMapper } from '../pg/row-mappers.js';
import type { ConsentCriteria, ConsentRepository } from './consent.repository.js';
import type {
  DeletionRequestCriteria,
  DeletionRequestRepository
} from './deletion-request.repository.js';

export function consentCriteriaSql(criteria: ConsentCriteria): WhereClause {
  return composeWhere(eq('user_id', criteria.userId));
}

export class PgConsentRepository
  extends PgRepositoryBase<ConsentRecord, ConsentCriteria>
  implements ConsentRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'privacy.consent_records',
      mapper: consentMapper,
      criteria: consentCriteriaSql
    });
  }
}

export function deletionRequestCriteriaSql(criteria: DeletionRequestCriteria): WhereClause {
  return composeWhere(eq('user_id', criteria.userId), eq('status', criteria.status));
}

export class PgDeletionRequestRepository
  extends PgRepositoryBase<DeletionRequest, DeletionRequestCriteria>
  implements DeletionRequestRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'privacy.data_requests',
      mapper: deletionRequestMapper,
      criteria: deletionRequestCriteriaSql
    });
  }
}

export function createPgConsentRepository(pool: pg.Pool): PgConsentRepository {
  return new PgConsentRepository(pool);
}

export function createPgDeletionRequestRepository(pool: pg.Pool): PgDeletionRequestRepository {
  return new PgDeletionRequestRepository(pool);
}
