import { ConflictException, Injectable } from '@nestjs/common';
import type { ApiListResponse, Chapter, ChapterEvent } from '@agric-platform/shared';
import { seedChapters } from '@agric-platform/shared';
import { InMemoryRepository, newId } from '../../common/in-memory.repository.js';
import { paginate } from '../../common/pagination.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  seedAnnouncements,
  seedChapterEvents,
  seedEventRsvps,
  type ChapterAnnouncement,
  type EventRsvp
} from '../../database/seed-data.js';

export interface CreateChapterInput {
  name: string;
  level: Chapter['level'];
  parentId?: string;
  state: string;
  lga?: string;
  leadUserId?: string;
}

export interface CreateEventInput {
  title: string;
  type: ChapterEvent['type'];
  startsAt: string;
  location: string;
}

export interface CreateAnnouncementInput {
  title: string;
  body: string;
  authorId: string;
}

@Injectable()
export class ChaptersService {
  private readonly chapters = new InMemoryRepository<Chapter>(seedChapters);
  private readonly eventsRepo = new InMemoryRepository<ChapterEvent>(seedChapterEvents);
  private readonly rsvps = new InMemoryRepository<EventRsvp>(seedEventRsvps);
  private readonly announcements = new InMemoryRepository<ChapterAnnouncement>(seedAnnouncements);

  constructor(private readonly domainEvents: DomainEventsService) {}

  list(filter: {
    level?: Chapter['level'];
    state?: string;
    parentId?: string;
    page?: number;
    pageSize?: number;
  }): ApiListResponse<Chapter> {
    let items = this.chapters.all();
    if (filter.level) items = items.filter((c) => c.level === filter.level);
    if (filter.state) items = items.filter((c) => c.state === filter.state);
    if (filter.parentId) items = items.filter((c) => c.parentId === filter.parentId);
    return paginate(items, filter.page, filter.pageSize);
  }

  all(): Chapter[] {
    return this.chapters.all();
  }

  getWithChildren(id: string): { chapter: Chapter; children: Chapter[] } {
    return {
      chapter: this.chapters.getById(id),
      children: this.chapters.find((c) => c.parentId === id)
    };
  }

  create(input: CreateChapterInput): Chapter {
    const chapter: Chapter = {
      id: newId('chapter'),
      name: input.name,
      level: input.level,
      parentId: input.parentId,
      state: input.state,
      lga: input.lga,
      leadUserId: input.leadUserId,
      memberCount: 0,
      active: true
    };
    const created = this.chapters.create(chapter);
    this.domainEvents.publish('chapter.chapter.created', { chapterId: created.id }, input.leadUserId);
    return created;
  }

  listEvents(chapterId: string): ChapterEvent[] {
    this.chapters.getById(chapterId);
    return this.eventsRepo.find((e) => e.chapterId === chapterId);
  }

  createEvent(chapterId: string, input: CreateEventInput, actorId: string): ChapterEvent {
    this.chapters.getById(chapterId);
    const event: ChapterEvent = {
      id: newId('event'),
      chapterId,
      title: input.title,
      type: input.type,
      startsAt: input.startsAt,
      location: input.location,
      rsvpCount: 0,
      attendanceCount: 0
    };
    const created = this.eventsRepo.create(event);
    this.domainEvents.publish('chapter.event.created', { eventId: created.id, chapterId }, actorId);
    return created;
  }

  getEvent(id: string): ChapterEvent {
    return this.eventsRepo.getById(id);
  }

  rsvp(eventId: string, userId: string): EventRsvp {
    const event = this.eventsRepo.getById(eventId);
    const existing = this.rsvps.findOne((r) => r.eventId === eventId && r.userId === userId);
    if (existing) {
      throw new ConflictException('User has already RSVPed to this event');
    }
    const rsvp: EventRsvp = {
      id: newId('rsvp'),
      eventId,
      userId,
      status: 'rsvp',
      createdAt: new Date().toISOString()
    };
    const created = this.rsvps.create(rsvp);
    this.eventsRepo.update(eventId, { rsvpCount: event.rsvpCount + 1 });
    this.domainEvents.publish('chapter.event.rsvp_recorded', { eventId }, userId);
    return created;
  }

  recordAttendance(eventId: string, userId: string): EventRsvp {
    const event = this.eventsRepo.getById(eventId);
    const existing = this.rsvps.findOne((r) => r.eventId === eventId && r.userId === userId);
    if (existing?.status === 'attended') {
      throw new ConflictException('Attendance already recorded for this user');
    }
    let record: EventRsvp;
    if (existing) {
      record = this.rsvps.update(existing.id, { status: 'attended' });
    } else {
      record = this.rsvps.create({
        id: newId('rsvp'),
        eventId,
        userId,
        status: 'attended',
        createdAt: new Date().toISOString()
      });
    }
    this.eventsRepo.update(eventId, { attendanceCount: event.attendanceCount + 1 });
    this.domainEvents.publish(
      'chapter.event.attendance_recorded',
      { eventId, chapterId: event.chapterId },
      userId
    );
    return record;
  }

  listAnnouncements(chapterId: string): ChapterAnnouncement[] {
    this.chapters.getById(chapterId);
    return this.announcements.find((a) => a.chapterId === chapterId);
  }

  createAnnouncement(chapterId: string, input: CreateAnnouncementInput): ChapterAnnouncement {
    this.chapters.getById(chapterId);
    const announcement: ChapterAnnouncement = {
      id: newId('ann'),
      chapterId,
      title: input.title,
      body: input.body,
      authorId: input.authorId,
      publishedAt: new Date().toISOString()
    };
    const created = this.announcements.create(announcement);
    this.domainEvents.publish(
      'chapter.announcement.published',
      { announcementId: created.id, chapterId },
      input.authorId
    );
    return created;
  }
}
