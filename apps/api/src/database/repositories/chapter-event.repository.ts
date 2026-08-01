import type { ChapterEvent } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedChapterEvents } from '../seed-data.js';

export interface ChapterEventCriteria {
  chapterId?: string;
}

export interface ChapterEventRepository
  extends AsyncRepository<ChapterEvent, ChapterEventCriteria> {
  /** Atomic rsvp_count increment. */
  incrementRsvp(id: string): Promise<ChapterEvent>;
  /** Atomic attendance_count increment. */
  incrementAttendance(id: string): Promise<ChapterEvent>;
}

export function chapterEventMatcher(
  criteria: ChapterEventCriteria
): (event: ChapterEvent) => boolean {
  return (event) => !criteria.chapterId || event.chapterId === criteria.chapterId;
}

export class InMemoryChapterEventRepository
  extends InMemoryRepository<ChapterEvent, ChapterEventCriteria>
  implements ChapterEventRepository
{
  constructor(seed: readonly ChapterEvent[] = []) {
    super(seed, chapterEventMatcher);
  }

  async incrementRsvp(id: string): Promise<ChapterEvent> {
    const event = await this.getById(id);
    return this.update(id, { rsvpCount: event.rsvpCount + 1 });
  }

  async incrementAttendance(id: string): Promise<ChapterEvent> {
    const event = await this.getById(id);
    return this.update(id, { attendanceCount: event.attendanceCount + 1 });
  }
}

export function createInMemoryChapterEventRepository(): InMemoryChapterEventRepository {
  return new InMemoryChapterEventRepository(seedChapterEvents);
}
