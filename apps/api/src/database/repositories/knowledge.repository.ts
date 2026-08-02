import type {
  ApiListResponse,
  KnowledgeFormat,
  KnowledgeResource,
  LanguageCode,
  PodcastEpisode
} from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface KnowledgeResourceCriteria {
  tag?: string;
  language?: LanguageCode;
  format?: KnowledgeFormat;
  offlineAvailable?: boolean;
}

export interface KnowledgeResourceRepository
  extends AsyncRepository<KnowledgeResource, KnowledgeResourceCriteria> {
  searchPage(
    criteria: KnowledgeResourceCriteria,
    page?: number,
    pageSize?: number
  ): Promise<ApiListResponse<KnowledgeResource>>;
  /** Atomic view-count increment. */
  incrementViewCount(id: string): Promise<KnowledgeResource>;
}

export function knowledgeResourceMatcher(
  criteria: KnowledgeResourceCriteria
): (resource: KnowledgeResource) => boolean {
  return (resource) =>
    (!criteria.tag || resource.tags.includes(criteria.tag)) &&
    (!criteria.language || resource.language === criteria.language) &&
    (!criteria.format || resource.format === criteria.format) &&
    (criteria.offlineAvailable === undefined || resource.offlineAvailable === criteria.offlineAvailable);
}

export class InMemoryKnowledgeResourceRepository
  extends InMemoryRepository<KnowledgeResource, KnowledgeResourceCriteria>
  implements KnowledgeResourceRepository
{
  constructor(seed: readonly KnowledgeResource[] = []) {
    super(seed, knowledgeResourceMatcher);
  }

  async incrementViewCount(id: string): Promise<KnowledgeResource> {
    const resource = await this.getById(id);
    return this.update(id, { viewCount: resource.viewCount + 1 });
  }
}

export type PodcastEpisodeRepository = AsyncRepository<PodcastEpisode, void>;

export class InMemoryPodcastEpisodeRepository
  extends InMemoryRepository<PodcastEpisode, void>
  implements PodcastEpisodeRepository
{
  constructor(seed: readonly PodcastEpisode[] = []) {
    super(seed);
  }
}

export function createInMemoryKnowledgeResourceRepository(): InMemoryKnowledgeResourceRepository {
  return new InMemoryKnowledgeResourceRepository();
}

export function createInMemoryPodcastEpisodeRepository(): InMemoryPodcastEpisodeRepository {
  return new InMemoryPodcastEpisodeRepository();
}
