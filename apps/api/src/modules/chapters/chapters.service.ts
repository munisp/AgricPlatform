import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import type { ApiListResponse, Chapter, ChapterEvent } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { resolveAttendanceSecret } from '../../config/attendance.config.js';
import {
  generateAttendanceCode,
  verifyAttendanceCode,
  type AttendanceCode
} from './attendance-codes.js';
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
  /**
   * HMAC key for QR attendance codes. Resolved at construction so a missing
   * ATTENDANCE_SIGNING_SECRET fails closed at bootstrap in production
   * (config/attendance.config.ts).
   */
  private readonly attendanceSecret: string;

  constructor(
    private readonly domainEvents: DomainEventsService,
    @Inject(CHAPTER_REPOSITORY) private readonly chapters: ChapterRepository,
    @Inject(CHAPTER_EVENT_REPOSITORY) private readonly eventsRepo: ChapterEventRepository,
    @Inject(EVENT_RSVP_REPOSITORY) private readonly rsvps: EventRsvpRepository,
    @Inject(ANNOUNCEMENT_REPOSITORY) private readonly announcements: AnnouncementRepository
  ) {
    this.attendanceSecret = resolveAttendanceSecret();
  }

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
    const created = await this.rsvps.recordRsvp(rsvp);
    await this.domainEvents.publish('chapter.event.rsvp_recorded', { eventId }, userId);
    return created;
  }

  async recordAttendance(eventId: string, userId: string): Promise<EventRsvp> {
    return this.checkIn(eventId, userId, {});
  }

  /**
   * Issue the signed QR attendance code for an event (Wave P3). The code is
   * bound to the event id and rotates on a 15-minute nonce window; chapter
   * leads render it as a QR at the venue and members scan it to check in.
   */
  async issueAttendanceCode(eventId: string): Promise<AttendanceCode> {
    const event = await this.eventsRepo.getById(eventId);
    return generateAttendanceCode(event.id, this.attendanceSecret);
  }

  /**
   * QR scan check-in (Wave P3): verifies the signed code (event binding,
   * HMAC signature, rotating-window expiry) and records attendance for the
   * member. Duplicate scans for the same member+event are rejected with a
   * distinct 409; the unique(event_id, user_id) constraint plus the upsert
   * repository keep retries idempotent.
   */
  async scanAttendance(eventId: string, code: string, memberId: string, scannerId: string): Promise<EventRsvp> {
    const event = await this.eventsRepo.getById(eventId);
    const verdict = verifyAttendanceCode(code, event.id, this.attendanceSecret);
    if (!verdict.ok) {
      if (verdict.reason === 'signature' || verdict.reason === 'wrong_event') {
        throw new UnauthorizedException('Invalid attendance code signature');
      }
      throw new BadRequestException(
        verdict.reason === 'expired'
          ? 'Attendance code has expired; ask the event lead for the current code'
          : 'Malformed attendance code'
      );
    }
    return this.checkIn(eventId, memberId, { scannerId });
  }

  private async checkIn(
    eventId: string,
    userId: string,
    scan: { scannerId?: string }
  ): Promise<EventRsvp> {
    await this.eventsRepo.getById(eventId);
    const existing = await this.rsvps.findByEventAndUser(eventId, userId);
    if (existing?.status === 'attended') {
      throw new ConflictException('Attendance already recorded for this member (duplicate scan)');
    }
    const record = await this.rsvps.recordAttendance({
      id: existing?.id ?? newId('rsvp'),
      eventId,
      userId,
      status: 'attended',
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      ...(scan.scannerId
        ? { scannedAt: new Date().toISOString(), scannerId: scan.scannerId }
        : {})
    });
    const event = await this.eventsRepo.getById(eventId);
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
