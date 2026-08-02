import type { Webinar, WebinarRegistration, WebinarStatus } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

export interface WebinarCriteria {
  status?: WebinarStatus;
  hostUserId?: string;
}

export type WebinarRepository = AsyncRepository<Webinar, WebinarCriteria>;

export function webinarMatcher(criteria: WebinarCriteria): (webinar: Webinar) => boolean {
  return (webinar) =>
    (!criteria.status || webinar.status === criteria.status) &&
    (!criteria.hostUserId || webinar.hostUserId === criteria.hostUserId);
}

export class InMemoryWebinarRepository
  extends InMemoryRepository<Webinar, WebinarCriteria>
  implements WebinarRepository
{
  constructor(seed: readonly Webinar[] = []) {
    super(seed, webinarMatcher);
  }
}

export interface WebinarRegistrationCriteria {
  webinarId?: string;
  userId?: string;
}

export type WebinarRegistrationRepository = AsyncRepository<
  WebinarRegistration,
  WebinarRegistrationCriteria
>;

export function webinarRegistrationMatcher(
  criteria: WebinarRegistrationCriteria
): (registration: WebinarRegistration) => boolean {
  return (registration) =>
    (!criteria.webinarId || registration.webinarId === criteria.webinarId) &&
    (!criteria.userId || registration.userId === criteria.userId);
}

export class InMemoryWebinarRegistrationRepository
  extends InMemoryRepository<WebinarRegistration, WebinarRegistrationCriteria>
  implements WebinarRegistrationRepository
{
  constructor(seed: readonly WebinarRegistration[] = []) {
    super(seed, webinarRegistrationMatcher);
  }
}

export function createInMemoryWebinarRepository(): InMemoryWebinarRepository {
  return new InMemoryWebinarRepository();
}

export function createInMemoryWebinarRegistrationRepository(): InMemoryWebinarRegistrationRepository {
  return new InMemoryWebinarRegistrationRepository();
}
