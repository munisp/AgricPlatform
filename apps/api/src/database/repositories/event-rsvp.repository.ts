import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedEventRsvps, type EventRsvp } from '../seed-data.js';
import type { ChapterEventRepository } from './chapter-event.repository.js';

export interface EventRsvpCriteria {
  eventId?: string;
  userId?: string;
  status?: EventRsvp['status'];
}

export interface EventRsvpRepository extends AsyncRepository<EventRsvp, EventRsvpCriteria> {
  findByEventAndUser(eventId: string, userId: string): Promise<EventRsvp | undefined>;
  /**
   * RSVP write + event rsvp_count increment as one atomic unit
   * (chapters.event_participation + chapters.events, plan §10 task 15).
   */
  recordRsvp(rsvp: EventRsvp): Promise<EventRsvp>;
  /**
   * Attendance upsert (ON CONFLICT (event_id,user_id) DO UPDATE) +
   * attendance_count increment as one atomic unit.
   */
  recordAttendance(rsvp: EventRsvp): Promise<EventRsvp>;
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
  constructor(
    seed: readonly EventRsvp[] = [],
    private readonly events?: ChapterEventRepository
  ) {
    super(seed, eventRsvpMatcher);
  }

  async findByEventAndUser(eventId: string, userId: string): Promise<EventRsvp | undefined> {
    return this.findOne({ eventId, userId });
  }

  async recordRsvp(rsvp: EventRsvp): Promise<EventRsvp> {
    const created = await this.create(rsvp);
    await this.events?.incrementRsvp(rsvp.eventId);
    return created;
  }

  async recordAttendance(rsvp: EventRsvp): Promise<EventRsvp> {
    const existing = await this.findByEventAndUser(rsvp.eventId, rsvp.userId);
    const record = existing
      ? await this.update(existing.id, { status: 'attended' })
      : await this.create(rsvp);
    await this.events?.incrementAttendance(rsvp.eventId);
    return record;
  }
}

export function createInMemoryEventRsvpRepository(
  events?: ChapterEventRepository
): InMemoryEventRsvpRepository {
  return new InMemoryEventRsvpRepository(seedEventRsvps, events);
}
