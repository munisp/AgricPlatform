import type { ApiListResponse, ForumTopic } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { ilike, InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedForumTopics } from '../seed-data.js';

export interface ForumTopicCriteria {
  category?: string;
  state?: string;
  crop?: string;
  q?: string;
}

export interface ForumTopicRepository extends AsyncRepository<ForumTopic, ForumTopicCriteria> {
  searchPage(
    criteria: ForumTopicCriteria,
    page?: number,
    pageSize?: number
  ): Promise<ApiListResponse<ForumTopic>>;
  /** Atomic reply_count increment (SQL: reply_count = reply_count + 1). */
  incrementReplyCount(id: string): Promise<ForumTopic>;
}

export function forumTopicMatcher(criteria: ForumTopicCriteria): (topic: ForumTopic) => boolean {
  return (topic) =>
    (!criteria.category || topic.category === criteria.category) &&
    (!criteria.state || topic.state === criteria.state) &&
    (!criteria.crop || topic.crop === criteria.crop) &&
    (!criteria.q || ilike(topic.title, criteria.q));
}

export class InMemoryForumTopicRepository
  extends InMemoryRepository<ForumTopic, ForumTopicCriteria>
  implements ForumTopicRepository
{
  constructor(seed: readonly ForumTopic[] = []) {
    super(seed, forumTopicMatcher);
  }

  async incrementReplyCount(id: string): Promise<ForumTopic> {
    const topic = await this.getById(id);
    return this.update(id, { replyCount: topic.replyCount + 1 });
  }
}

export function createInMemoryForumTopicRepository(): InMemoryForumTopicRepository {
  return new InMemoryForumTopicRepository(seedForumTopics);
}
