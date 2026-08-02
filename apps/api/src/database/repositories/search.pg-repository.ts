import type pg from 'pg';
import type { SearchQueryEvent } from '@agric-platform/shared';
import { composeWhere, PgRepositoryBase, type WhereClause } from '../pg/pg-repository.base.js';
import { recommendationFeedbackMapper, searchQueryMapper } from '../pg/row-mappers.js';
import type { SearchQueryCriteria, SearchQueryRepository } from './search-query.repository.js';
import type {
  RecommendationFeedbackCriteria,
  RecommendationFeedbackEvent,
  RecommendationFeedbackRepository
} from './recommendation-feedback.repository.js';

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

// ---------------------------------------------------------------------------
// Wave P5c: recommendation feedback events (search.recommendation_feedback).
// ---------------------------------------------------------------------------

export function recommendationFeedbackCriteriaSql(
  criteria: RecommendationFeedbackCriteria
): WhereClause {
  return composeWhere(
    criteria.userId === undefined ? null : { where: 'user_id = $1', params: [criteria.userId] },
    criteria.itemType === undefined ? null : { where: 'item_type = $1', params: [criteria.itemType] },
    criteria.itemId === undefined ? null : { where: 'item_id = $1', params: [criteria.itemId] }
  );
}

export class PgRecommendationFeedbackRepository
  extends PgRepositoryBase<RecommendationFeedbackEvent, RecommendationFeedbackCriteria>
  implements RecommendationFeedbackRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'search.recommendation_feedback',
      mapper: recommendationFeedbackMapper,
      criteria: recommendationFeedbackCriteriaSql,
      orderBy: 'created_at'
    });
  }
}

export function createPgRecommendationFeedbackRepository(
  pool: pg.Pool
): PgRecommendationFeedbackRepository {
  return new PgRecommendationFeedbackRepository(pool);
}
