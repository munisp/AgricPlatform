import type { CohortThread, CohortThreadPost } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface CohortThreadCriteria {
  cohortId?: string;
}

export interface CohortThreadRepository extends AsyncRepository<CohortThread, CohortThreadCriteria> {
  /** Thread insert; reply counter is maintained by the post repository. */
  incrementReplyCount(id: string): Promise<CohortThread>;
}

export function cohortThreadMatcher(criteria: CohortThreadCriteria): (thread: CohortThread) => boolean {
  return (thread) => !criteria.cohortId || thread.cohortId === criteria.cohortId;
}

export class InMemoryCohortThreadRepository
  extends InMemoryRepository<CohortThread, CohortThreadCriteria>
  implements CohortThreadRepository
{
  constructor(seed: readonly CohortThread[] = []) {
    super(seed, cohortThreadMatcher);
  }

  async incrementReplyCount(id: string): Promise<CohortThread> {
    const thread = await this.getById(id);
    return this.update(id, { replyCount: thread.replyCount + 1 });
  }
}

export interface CohortThreadPostCriteria {
  threadId?: string;
  authorId?: string;
}

export type CohortThreadPostRepository = AsyncRepository<CohortThreadPost, CohortThreadPostCriteria>;

export function cohortThreadPostMatcher(
  criteria: CohortThreadPostCriteria
): (post: CohortThreadPost) => boolean {
  return (post) =>
    (!criteria.threadId || post.threadId === criteria.threadId) &&
    (!criteria.authorId || post.authorId === criteria.authorId);
}

export class InMemoryCohortThreadPostRepository
  extends InMemoryRepository<CohortThreadPost, CohortThreadPostCriteria>
  implements CohortThreadPostRepository
{
  constructor(seed: readonly CohortThreadPost[] = []) {
    super(seed, cohortThreadPostMatcher);
  }
}

export function createInMemoryCohortThreadRepository(): InMemoryCohortThreadRepository {
  return new InMemoryCohortThreadRepository();
}

export function createInMemoryCohortThreadPostRepository(): InMemoryCohortThreadPostRepository {
  return new InMemoryCohortThreadPostRepository();
}
