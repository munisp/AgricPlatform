import type { MentorRequest } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedMentorRequests } from '../seed-data.js';

export interface MentorRequestCriteria {
  userId?: string;
  status?: MentorRequest['status'];
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MentorRequestRepository
  extends AsyncRepository<MentorRequest, MentorRequestCriteria> {}

export function mentorRequestMatcher(
  criteria: MentorRequestCriteria
): (request: MentorRequest) => boolean {
  return (request) =>
    (!criteria.userId || request.userId === criteria.userId) &&
    (!criteria.status || request.status === criteria.status);
}

export class InMemoryMentorRequestRepository
  extends InMemoryRepository<MentorRequest, MentorRequestCriteria>
  implements MentorRequestRepository
{
  constructor(seed: readonly MentorRequest[] = []) {
    super(seed, mentorRequestMatcher);
  }
}

export function createInMemoryMentorRequestRepository(): InMemoryMentorRequestRepository {
  return new InMemoryMentorRequestRepository(seedMentorRequests);
}
