import type pg from 'pg';
import { composeWhere, eq, PgRepositoryBase, type WhereClause } from '../pg/pg-repository.base.js';
import { successionClaimMapper } from '../pg/row-mappers.js';
import type {
  SuccessionClaim,
  SuccessionClaimCriteria,
  SuccessionClaimRepository
} from './succession.repository.js';

export function successionClaimCriteriaSql(criteria: SuccessionClaimCriteria): WhereClause {
  return composeWhere(
    eq('deceased_user_id', criteria.deceasedUserId),
    eq('heir_user_id', criteria.heirUserId),
    eq('status', criteria.status)
  );
}

/** V-09: identity.succession_claims (migration 086). */
export class PgSuccessionClaimRepository
  extends PgRepositoryBase<SuccessionClaim, SuccessionClaimCriteria>
  implements SuccessionClaimRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'identity.succession_claims',
      mapper: successionClaimMapper,
      criteria: successionClaimCriteriaSql
    });
  }
}

export function createPgSuccessionClaimRepository(pool: pg.Pool): PgSuccessionClaimRepository {
  return new PgSuccessionClaimRepository(pool);
}
