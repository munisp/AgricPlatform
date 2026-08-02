import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import type { DeletionRequest } from '../seed-data.js';

export interface DeletionRequestCriteria {
  userId?: string;
  status?: DeletionRequest['status'];
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DeletionRequestRepository
  extends AsyncRepository<DeletionRequest, DeletionRequestCriteria> {}

export function deletionRequestMatcher(
  criteria: DeletionRequestCriteria
): (request: DeletionRequest) => boolean {
  return (request) =>
    (!criteria.userId || request.userId === criteria.userId) &&
    (!criteria.status || request.status === criteria.status);
}

export class InMemoryDeletionRequestRepository
  extends InMemoryRepository<DeletionRequest, DeletionRequestCriteria>
  implements DeletionRequestRepository
{
  constructor(seed: readonly DeletionRequest[] = []) {
    super(seed, deletionRequestMatcher);
  }
}

export function createInMemoryDeletionRequestRepository(): InMemoryDeletionRequestRepository {
  return new InMemoryDeletionRequestRepository([]);
}
