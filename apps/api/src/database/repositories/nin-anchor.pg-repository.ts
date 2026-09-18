import type pg from 'pg';
import { composeWhere, eq, PgRepositoryBase, type WhereClause } from '../pg/pg-repository.base.js';
import { accountMergeMapper, ninAnchorMapper } from '../pg/row-mappers.js';
import type {
  AccountMerge,
  AccountMergeCriteria,
  AccountMergeRepository,
  NinAnchor,
  NinAnchorCriteria,
  NinAnchorRepository
} from './nin-anchor.repository.js';

export function ninAnchorCriteriaSql(criteria: NinAnchorCriteria): WhereClause {
  return composeWhere(
    eq('user_id', criteria.userId),
    eq('nin_hash', criteria.ninHash),
    eq('status', criteria.status)
  );
}

/** V-45: identity.nin_anchors (migration 088). */
export class PgNinAnchorRepository
  extends PgRepositoryBase<NinAnchor, NinAnchorCriteria>
  implements NinAnchorRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'identity.nin_anchors',
      mapper: ninAnchorMapper,
      criteria: ninAnchorCriteriaSql
    });
  }
}

export function accountMergeCriteriaSql(criteria: AccountMergeCriteria): WhereClause {
  return composeWhere(
    eq('primary_user_id', criteria.primaryUserId),
    eq('duplicate_user_id', criteria.duplicateUserId)
  );
}

/** V-45: identity.account_merges (migration 088) — append-only. */
export class PgAccountMergeRepository
  extends PgRepositoryBase<AccountMerge, AccountMergeCriteria>
  implements AccountMergeRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'identity.account_merges',
      mapper: accountMergeMapper,
      criteria: accountMergeCriteriaSql
    });
  }
}

export function createPgNinAnchorRepository(pool: pg.Pool): PgNinAnchorRepository {
  return new PgNinAnchorRepository(pool);
}

export function createPgAccountMergeRepository(pool: pg.Pool): PgAccountMergeRepository {
  return new PgAccountMergeRepository(pool);
}
