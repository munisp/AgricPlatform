import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import type { TopicFlag } from '../seed-data.js';

export interface TopicFlagCriteria {
  status?: TopicFlag['status'];
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TopicFlagRepository extends AsyncRepository<TopicFlag, TopicFlagCriteria> {}

export function topicFlagMatcher(criteria: TopicFlagCriteria): (flag: TopicFlag) => boolean {
  return (flag) => !criteria.status || flag.status === criteria.status;
}

export class InMemoryTopicFlagRepository
  extends InMemoryRepository<TopicFlag, TopicFlagCriteria>
  implements TopicFlagRepository
{
  constructor(seed: readonly TopicFlag[] = []) {
    super(seed, topicFlagMatcher);
  }
}

export function createInMemoryTopicFlagRepository(): InMemoryTopicFlagRepository {
  return new InMemoryTopicFlagRepository([]);
}
