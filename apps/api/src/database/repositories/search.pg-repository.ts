import type pg from 'pg';
import type { SearchQueryEvent } from '@agric-platform/shared';
import { composeWhere, PgRepositoryBase, type WhereClause } from '../pg/pg-repository.base.js';
import { searchQueryMapper } from '../pg/row-mappers.js';
import type { SearchQueryCriteria, SearchQueryRepository } from './search-query.repository.js';

export function searchQueryCriteriaSql(criteria: SearchQueryCriteria): WhereClause {
  return composeWhere(
    criteria.since === undefined
      ? null
      : { where: 'occurred_at >= $1', params: [criteria.since] }
  );
}

export class PgSearchQueryRepository
  extends PgRepositoryBase<SearchQueryEvent, SearchQueryCriteria>
  implements SearchQueryRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'search.query_events',
      mapper: searchQueryMapper,
      criteria: searchQueryCriteriaSql,
      orderBy: 'occurred_at'
    });
  }
}

export function createPgSearchQueryRepository(pool: pg.Pool): PgSearchQueryRepository {
  return new PgSearchQueryRepository(pool);
}
