import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedEventRsvps, type EventRsvp } from '../seed-data.js';

export interface EventRsvpCriteria {
  eventId?: string;
  userId?: string;
  status?: EventRsvp['status'];
}

export interface EventRsvpRepository extends AsyncRepository<EventRsvp, EventRsvpCriteria> {
  findByEventAndUser(eventId: string, userId: string): Promise<EventRsvp | undefined>;
}

export function eventRsvpMatcher(criteria: EventRsvpCriteria): (rsvp: EventRsvp) => boolean {
  return (rsvp) =>
    (!criteria.eventId || rsvp.eventId === criteria.eventId) &&
    (!criteria.userId || rsvp.userId === criteria.userId) &&
    (!criteria.status || rsvp.status === criteria.status);
}

export class InMemoryEventRsvpRepository
  extends InMemoryRepository<EventRsvp, EventRsvpCriteria>
  implements EventRsvpRepository
{
  constructor(seed: readonly EventRsvp[] = []) {
    super(seed, eventRsvpMatcher);
  }

  async findByEventAndUser(eventId: string, userId: string): Promise<EventRsvp | undefined> {
    return this.findOne({ eventId, userId });
  }
}

export function createInMemoryEventRsvpRepository(): InMemoryEventRsvpRepository {
  return new InMemoryEventRsvpRepository(seedEventRsvps);
}
