import type { ApiListResponse, Chapter } from '@agric-platform/shared';
import { seedChapters } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface ChapterCriteria {
  level?: Chapter['level'];
  state?: string;
  parentId?: string;
}

export interface ChapterRepository extends AsyncRepository<Chapter, ChapterCriteria> {
  searchPage(
    criteria: ChapterCriteria,
    page?: number,
    pageSize?: number
  ): Promise<ApiListResponse<Chapter>>;
}

export function chapterMatcher(criteria: ChapterCriteria): (chapter: Chapter) => boolean {
  return (chapter) =>
    (!criteria.level || chapter.level === criteria.level) &&
    (!criteria.state || chapter.state === criteria.state) &&
    (!criteria.parentId || chapter.parentId === criteria.parentId);
}

export class InMemoryChapterRepository
  extends InMemoryRepository<Chapter, ChapterCriteria>
  implements ChapterRepository
{
  constructor(seed: readonly Chapter[] = []) {
    super(seed, chapterMatcher);
  }
}

export function createInMemoryChapterRepository(): InMemoryChapterRepository {
  return new InMemoryChapterRepository(seedChapters);
}
