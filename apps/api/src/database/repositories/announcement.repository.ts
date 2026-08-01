import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedAnnouncements, type ChapterAnnouncement } from '../seed-data.js';

export interface AnnouncementCriteria {
  chapterId?: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AnnouncementRepository
  extends AsyncRepository<ChapterAnnouncement, AnnouncementCriteria> {}

export function announcementMatcher(
  criteria: AnnouncementCriteria
): (announcement: ChapterAnnouncement) => boolean {
  return (announcement) => !criteria.chapterId || announcement.chapterId === criteria.chapterId;
}

export class InMemoryAnnouncementRepository
  extends InMemoryRepository<ChapterAnnouncement, AnnouncementCriteria>
  implements AnnouncementRepository
{
  constructor(seed: readonly ChapterAnnouncement[] = []) {
    super(seed, announcementMatcher);
  }
}

export function createInMemoryAnnouncementRepository(): InMemoryAnnouncementRepository {
  return new InMemoryAnnouncementRepository(seedAnnouncements);
}
