import type pg from 'pg';
import type { ForumTopic, MentorRequest } from '@agric-platform/shared';
import type { TopicFlag } from '../seed-data.js';
import {
  composeWhere,
  eq,
  ilike,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import { forumTopicMapper, mentorRequestMapper, topicFlagMapper } from '../pg/row-mappers.js';
import type { ForumTopicCriteria, ForumTopicRepository } from './forum-topic.repository.js';
import type { MentorRequestCriteria, MentorRequestRepository } from './mentor-request.repository.js';
import type { TopicFlagCriteria, TopicFlagRepository } from './topic-flag.repository.js';

export function forumTopicCriteriaSql(criteria: ForumTopicCriteria): WhereClause {
  return composeWhere(
    eq('category', criteria.category),
    eq('state', criteria.state),
    eq('crop', criteria.crop),
    ilike('title', criteria.q)
  );
}

export class PgForumTopicRepository
  extends PgRepositoryBase<ForumTopic, ForumTopicCriteria>
  implements ForumTopicRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'community.forum_topics',
      mapper: forumTopicMapper,
      criteria: forumTopicCriteriaSql
    });
  }

  /** Atomic reply_count increment (single UPDATE). */
  async incrementReplyCount(id: string): Promise<ForumTopic> {
    const result = await this.pool.query(
      `UPDATE community.forum_topics SET reply_count = reply_count + 1
        WHERE id = $1 RETURNING ${forumTopicMapper.columns.join(', ')}`,
      [id]
    );
    if (!result.rows[0]) {
      return this.getById(id); // raises NotFoundException
    }
    return forumTopicMapper.fromRow(result.rows[0]);
  }
}

export function mentorRequestCriteriaSql(criteria: MentorRequestCriteria): WhereClause {
  return composeWhere(eq('user_id', criteria.userId), eq('status', criteria.status));
}

export class PgMentorRequestRepository
  extends PgRepositoryBase<MentorRequest, MentorRequestCriteria>
  implements MentorRequestRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'community.mentor_requests',
      mapper: mentorRequestMapper,
      criteria: mentorRequestCriteriaSql
    });
  }
}

export function topicFlagCriteriaSql(criteria: TopicFlagCriteria): WhereClause {
  return composeWhere(eq('status', criteria.status));
}

export class PgTopicFlagRepository
  extends PgRepositoryBase<TopicFlag, TopicFlagCriteria>
  implements TopicFlagRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'community.topic_flags',
      mapper: topicFlagMapper,
      criteria: topicFlagCriteriaSql
    });
  }
}

export function createPgForumTopicRepository(pool: pg.Pool): PgForumTopicRepository {
  return new PgForumTopicRepository(pool);
}

export function createPgMentorRequestRepository(pool: pg.Pool): PgMentorRequestRepository {
  return new PgMentorRequestRepository(pool);
}

export function createPgTopicFlagRepository(pool: pg.Pool): PgTopicFlagRepository {
  return new PgTopicFlagRepository(pool);
}
