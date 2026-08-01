import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { ApiListResponse, Chapter, ChapterEvent } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import {
  ANNOUNCEMENT_REPOSITORY,
  CHAPTER_EVENT_REPOSITORY,
  CHAPTER_REPOSITORY,
  EVENT_RSVP_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { AnnouncementRepository } from '../../database/repositories/announcement.repository.js';
import type { ChapterEventRepository } from '../../database/repositories/chapter-event.repository.js';
import type {
  ChapterCriteria,
  ChapterRepository
} from '../../database/repositories/chapter.repository.js';
import type { EventRsvpRepository } from '../../database/repositories/event-rsvp.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import type { ChapterAnnouncement, EventRsvp } from '../../database/seed-data.js';

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
  constructor(
    private readonly domainEvents: DomainEventsService,
    @Inject(CHAPTER_REPOSITORY) private readonly chapters: ChapterRepository,
    @Inject(CHAPTER_EVENT_REPOSITORY) private readonly eventsRepo: ChapterEventRepository,
    @Inject(EVENT_RSVP_REPOSITORY) private readonly rsvps: EventRsvpRepository,
    @Inject(ANNOUNCEMENT_REPOSITORY) private readonly announcements: AnnouncementRepository
  ) {}

  async list(
    filter: ChapterCriteria & { page?: number; pageSize?: number }
  ): Promise<ApiListResponse<Chapter>> {
    return this.chapters.searchPage(
      { level: filter.level, state: filter.state, parentId: filter.parentId },
      filter.page,
      filter.pageSize
    );
  }

  async all(): Promise<Chapter[]> {
    return this.chapters.all();
  }

  async getWithChildren(id: string): Promise<{ chapter: Chapter; children: Chapter[] }> {
    return {
      chapter: await this.chapters.getById(id),
      children: await this.chapters.find({ parentId: id })
    };
  }

  async create(input: CreateChapterInput): Promise<Chapter> {
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
    const created = await this.chapters.create(chapter);
    await this.domainEvents.publish('chapter.chapter.created', { chapterId: created.id }, input.leadUserId);
    return created;
  }

  async listEvents(chapterId: string): Promise<ChapterEvent[]> {
    await this.chapters.getById(chapterId);
    return this.eventsRepo.find({ chapterId });
  }

  async createEvent(chapterId: string, input: CreateEventInput, actorId: string): Promise<ChapterEvent> {
    await this.chapters.getById(chapterId);
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
    const created = await this.eventsRepo.create(event);
    await this.domainEvents.publish('chapter.event.created', { eventId: created.id, chapterId }, actorId);
    return created;
  }

  async getEvent(id: string): Promise<ChapterEvent> {
    return this.eventsRepo.getById(id);
  }

  async rsvp(eventId: string, userId: string): Promise<EventRsvp> {
    await this.eventsRepo.getById(eventId);
    if (await this.rsvps.findByEventAndUser(eventId, userId)) {
      throw new ConflictException('User has already RSVPed to this event');
    }
    const rsvp: EventRsvp = {
      id: newId('rsvp'),
      eventId,
      userId,
      status: 'rsvp',
      createdAt: new Date().toISOString()
    };
    const created = await this.rsvps.create(rsvp);
    await this.eventsRepo.incrementRsvp(eventId);
    await this.domainEvents.publish('chapter.event.rsvp_recorded', { eventId }, userId);
    return created;
  }

  async recordAttendance(eventId: string, userId: string): Promise<EventRsvp> {
    await this.eventsRepo.getById(eventId);
    const existing = await this.rsvps.findByEventAndUser(eventId, userId);
    if (existing?.status === 'attended') {
      throw new ConflictException('Attendance already recorded for this user');
    }
    let record: EventRsvp;
    if (existing) {
      record = await this.rsvps.update(existing.id, { status: 'attended' });
    } else {
      record = await this.rsvps.create({
        id: newId('rsvp'),
        eventId,
        userId,
        status: 'attended',
        createdAt: new Date().toISOString()
      });
    }
    const event = await this.eventsRepo.incrementAttendance(eventId);
    await this.domainEvents.publish(
      'chapter.event.attendance_recorded',
      { eventId, chapterId: event.chapterId },
      userId
    );
    return record;
  }

  async listAnnouncements(chapterId: string): Promise<ChapterAnnouncement[]> {
    await this.chapters.getById(chapterId);
    return this.announcements.find({ chapterId });
  }

  async createAnnouncement(
    chapterId: string,
    input: CreateAnnouncementInput
  ): Promise<ChapterAnnouncement> {
    await this.chapters.getById(chapterId);
    const announcement: ChapterAnnouncement = {
      id: newId('ann'),
      chapterId,
      title: input.title,
      body: input.body,
      authorId: input.authorId,
      publishedAt: new Date().toISOString()
    };
    const created = await this.announcements.create(announcement);
    await this.domainEvents.publish(
      'chapter.announcement.published',
      { announcementId: created.id, chapterId },
      input.authorId
    );
    return created;
  }
}
