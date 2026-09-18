import type pg from 'pg';
import { composeWhere, eq, PgRepositoryBase, type WhereClause } from '../pg/pg-repository.base.js';
import { erasureHoldMapper } from '../pg/row-mappers.js';
import type {
  ErasureHold,
  ErasureHoldCriteria,
  ErasureHoldRepository
} from './erasure-hold.repository.js';

export function erasureHoldCriteriaSql(criteria: ErasureHoldCriteria): WhereClause {
  return composeWhere(eq('user_id', criteria.userId), eq('category', criteria.category));
}

/** V-25: privacy.erasure_holds (migration 089). */
export class PgErasureHoldRepository
  extends PgRepositoryBase<ErasureHold, ErasureHoldCriteria>
  implements ErasureHoldRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'privacy.erasure_holds',
      mapper: erasureHoldMapper,
      criteria: erasureHoldCriteriaSql
    });
  }
}

export function createPgErasureHoldRepository(pool: pg.Pool): PgErasureHoldRepository {
  return new PgErasureHoldRepository(pool);
}
