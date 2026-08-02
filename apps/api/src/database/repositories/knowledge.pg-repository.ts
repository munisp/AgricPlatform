import type pg from 'pg';
import type { KnowledgeResource, PodcastEpisode, Webinar, WebinarRegistration } from '@agric-platform/shared';
import {
  arrayContains,
  composeWhere,
  eq,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import {
  knowledgeResourceMapper,
  podcastEpisodeMapper,
  webinarMapper,
  webinarRegistrationMapper
} from '../pg/row-mappers.js';
import type { KnowledgeResourceCriteria, KnowledgeResourceRepository, PodcastEpisodeRepository } from './knowledge.repository.js';
import type {
  WebinarCriteria,
  WebinarRegistrationCriteria,
  WebinarRegistrationRepository,
  WebinarRepository
} from './webinar.repository.js';

export function knowledgeResourceCriteriaSql(criteria: KnowledgeResourceCriteria): WhereClause {
  return composeWhere(
    arrayContains('tags', criteria.tag),
    eq('language', criteria.language),
    eq('format', criteria.format),
    eq('offline_available', criteria.offlineAvailable)
  );
}

const RESOURCE_COLUMNS = knowledgeResourceMapper.columns.join(', ');

export class PgKnowledgeResourceRepository
  extends PgRepositoryBase<KnowledgeResource, KnowledgeResourceCriteria>
  implements KnowledgeResourceRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'knowledge.resources',
      mapper: knowledgeResourceMapper,
      criteria: knowledgeResourceCriteriaSql
    });
  }

  async incrementViewCount(id: string): Promise<KnowledgeResource> {
    const result = await this.pool.query(
      `UPDATE knowledge.resources SET view_count = view_count + 1
        WHERE id = $1 RETURNING ${RESOURCE_COLUMNS}`,
      [id]
    );
    if (!result.rows[0]) {
      return this.getById(id); // raises NotFoundException
    }
    return knowledgeResourceMapper.fromRow(result.rows[0]);
  }
}

export class PgPodcastEpisodeRepository
  extends PgRepositoryBase<PodcastEpisode, void>
  implements PodcastEpisodeRepository
{
  constructor(pool: pg.Pool) {
    super(pool, { table: 'knowledge.podcast_episodes', mapper: podcastEpisodeMapper });
  }
}

export function webinarCriteriaSql(criteria: WebinarCriteria): WhereClause {
  return composeWhere(eq('status', criteria.status), eq('host_user_id', criteria.hostUserId));
}

export class PgWebinarRepository
  extends PgRepositoryBase<Webinar, WebinarCriteria>
  implements WebinarRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'knowledge.webinars',
      mapper: webinarMapper,
      criteria: webinarCriteriaSql
    });
  }
}

export function webinarRegistrationCriteriaSql(criteria: WebinarRegistrationCriteria): WhereClause {
  return composeWhere(eq('webinar_id', criteria.webinarId), eq('user_id', criteria.userId));
}

export class PgWebinarRegistrationRepository
  extends PgRepositoryBase<WebinarRegistration, WebinarRegistrationCriteria>
  implements WebinarRegistrationRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'knowledge.webinar_registrations',
      mapper: webinarRegistrationMapper,
      criteria: webinarRegistrationCriteriaSql
    });
  }
}

export function createPgKnowledgeResourceRepository(pool: pg.Pool): PgKnowledgeResourceRepository {
  return new PgKnowledgeResourceRepository(pool);
}

export function createPgPodcastEpisodeRepository(pool: pg.Pool): PgPodcastEpisodeRepository {
  return new PgPodcastEpisodeRepository(pool);
}

export function createPgWebinarRepository(pool: pg.Pool): PgWebinarRepository {
  return new PgWebinarRepository(pool);
}

export function createPgWebinarRegistrationRepository(pool: pg.Pool): PgWebinarRegistrationRepository {
  return new PgWebinarRegistrationRepository(pool);
}
