import type pg from 'pg';
import type { AdvisoryItem } from '@agric-platform/shared';
import {
  composeWhere,
  eq,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import { advisoryMapper } from '../pg/row-mappers.js';
import type { AdvisoryCriteria, AdvisoryRepository } from './advisory.repository.js';

export function advisoryCriteriaSql(criteria: AdvisoryCriteria): WhereClause {
  return composeWhere(eq('kind', criteria.kind), eq('state', criteria.state), eq('crop', criteria.crop));
}

export class PgAdvisoryRepository
  extends PgRepositoryBase<AdvisoryItem, AdvisoryCriteria>
  implements AdvisoryRepository
{
  constructor(pool: pg.Pool) {
    super(pool, { table: 'advisory.items', mapper: advisoryMapper, criteria: advisoryCriteriaSql });
  }
}

export function createPgAdvisoryRepository(pool: pg.Pool): PgAdvisoryRepository {
  return new PgAdvisoryRepository(pool);
}
