import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  Announcement,
  Chapter,
  ChapterEvent,
  ChapterMember,
  EventRsvp,
  User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import {
  ANNOUNCEMENT_REPOSITORY,
  CHAPTER_EVENT_REPOSITORY,
  CHAPTER_MEMBER_REPOSITORY,
  CHAPTER_REPOSITORY,
  EVENT_RSVP_REPOSITORY,
  USER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { AnnouncementRepository } from '../../database/repositories/announcement.repository.js';
import type { ChapterEventRepository } from '../../database/repositories/chapter-event.repository.js';
import type { ChapterMemberRepository } from '../../database/repositories/chapter-member.repository.js';
import type { ChapterCriteria, ChapterRepository } from '../../database/repositories/chapter.repository.js';
import type { EventRsvpRepository } from '../../database/repositories/event-rsvp.repository.js';
import type { UserRepository } from '../../database/repositories/user.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';

export interface CreateChapterInput {
  name: string;
  level: Chapter['level'];
  parentId?: string;
  state: string;
  lga?: string;
  ward?: string;
  leadUserId?: string;
}

export interface CreateEventInput {
  title: string;
  type: ChapterEvent['type'];
  startsAt: string;
  location: string;
  description?: string;
  endsAt?: string;
}

export interface CreateAnnouncementInput {
  title: string;
  body: string;
  authorId: string;
}

/** Signed attendance-code window: 15 minutes. */
const ATTENDANCE_WINDOW_SECONDS = 15 * 60;
const ATTENDANCE_SECRET_ENV = 'CHAPTER_ATTENDANCE_SECRET';
const DEV_ATTENDANCE_SECRET = 'chapter-attendance-dev-secret-INSECURE';

function attendanceSecret(): string {
  return process.env[ATTENDANCE_SECRET_ENV] ?? DEV_ATTENDANCE_SECRET;
}

/** v1.<eventId>.<window>.<hmac> — deterministic, verifiable without storage. */
function signAttendanceCode(eventId: string, window: number): string {
  const hmac = createHmac('sha256', attendanceSecret())
    .update(`v1.${eventId}.${window}`)
    .digest('hex')
    .slice(0, 24);
  return `v1.${eventId}.${window}.${hmac}`;
}

/**
 * Chapters & events. Chapter creation is admin/chapter_lead; events and
 * announcements are chapter-lead-or-admin of THAT chapter; RSVPs are
 * self-service; QR attendance codes are signed HMAC tokens with a rotating
 * 15-minute window.
 */
@Injectable()
export class ChaptersService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(CHAPTER_REPOSITORY) private readonly chapters: ChapterRepository,
    @Inject(CHAPTER_MEMBER_REPOSITORY) private readonly members: ChapterMemberRepository,
    @Inject(CHAPTER_EVENT_REPOSITORY) private readonly chapterEvents: ChapterEventRepository,
    @Inject(EVENT_RSVP_REPOSITORY) private readonly rsvps: EventRsvpRepository,
    @Inject(ANNOUNCEMENT_REPOSITORY) private readonly announcements: AnnouncementRepository,
    @Inject(USER_REPOSITORY) private readonly users?: UserRepository
  ) {}

  list(criteria: ChapterCriteria) {
    return this.chapters.searchPage(criteria, criteria.page ?? 1, criteria.pageSize ?? 20);
  }

  async get(id: string): Promise<Chapter> {
    return this.chapters.getById(id);
  }

  async getWithChildren(id: string): Promise<Chapter & { children: Chapter[] }> {
    const chapter = await this.chapters.getById(id);
    const children = await this.chapters.find({ parentId: id });
    return { ...chapter, children };
  }

  async create(input: CreateChapterInput): Promise<Chapter> {
    if (input.parentId) {
      await this.chapters.getById(input.parentId);
    }
    const chapter = await this.chapters.create({
      id: newId('chapter'),
      name: input.name,
      level: input.level,
      parentId: input.parentId,
      state: input.state,
      lga: input.lga,
      ward: input.ward,
      leadUserId: input.leadUserId,
      createdAt: new Date().toISOString()
    });
    await this.events.publish('chapters.chapter.created', {
      chapterId: chapter.id,
      level: chapter.level
    });
    return chapter;
  }

  /** Chapter leads govern their own chapter; admins govern all. */
  async assertChapterLeadOrAdmin(actor: User | null, chapterId: string): Promise<void> {
    if (!actor) {
      throw new UnauthorizedException('Authentication required');
    }
    if (actor.roles.includes('admin')) {
      return;
    }
    const chapter = await this.chapters.getById(chapterId);
    if (chapter.leadUserId !== actor.id) {
      throw new ForbiddenException('Only the chapter lead or an admin may manage this chapter');
    }
  }

  /* ------------------------------ membership ------------------------------ */

  async listMembers(chapterId: string): Promise<ChapterMember[]> {
    await this.chapters.getById(chapterId);
    return this.members.list(chapterId);
  }

  async addMember(chapterId: string, userId: string, role: ChapterMember['role'] = 'member'): Promise<ChapterMember> {
    await this.chapters.getById(chapterId);
    if (this.users) {
      const user = await this.users.findById(userId);
      if (!user) {
        throw new NotFoundException(`User '${userId}' not found`);
      }
    }
    const member = await this.members.add({
      chapterId,
      userId,
      role,
      joinedAt: new Date().toISOString()
    });
    await this.events.publish('chapters.member.joined', { chapterId, userId, role });
    return member;
  }

  async removeMember(chapterId: string, userId: string): Promise<{ removed: true }> {
    await this.chapters.getById(chapterId);
    const removed = await this.members.remove(chapterId, userId);
    if (!removed) {
      throw new NotFoundException(`User '${userId}' is not a member of chapter '${chapterId}'`);
    }
    await this.events.publish('chapters.member.removed', { chapterId, userId });
    return { removed: true };
  }

  /* -------------------------------- events -------------------------------- */

  listEvents(chapterId: string): Promise<ChapterEvent[]> {
    return this.chapterEvents.find({ chapterId });
  }

  async getEvent(id: string): Promise<ChapterEvent> {
    return this.chapterEvents.getById(id);
  }

  async createEvent(chapterId: string, input: CreateEventInput, createdBy: string): Promise<ChapterEvent> {
    await this.chapters.getById(chapterId);
    const event = await this.chapterEvents.create({
      id: newId('event'),
      chapterId,
      title: input.title,
      type: input.type,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      location: input.location,
      description: input.description,
      createdBy,
      createdAt: new Date().toISOString()
    });
    await this.events.publish('chapters.event.created', { chapterId, eventId: event.id });
    return event;
  }

  /** Event roster for leads: RSVP rows joined with real member names (G7). */
  async eventRoster(eventId: string): Promise<{ userId: string; fullName: string; status: string }[]> {
    await this.chapterEvents.getById(eventId);
    const rsvpRows = await this.rsvps.find({ eventId });
    const roster: { userId: string; fullName: string; status: string }[] = [];
    for (const rsvp of rsvpRows) {
      const user = this.users ? await this.users.findById(rsvp.userId) : undefined;
      roster.push({
        userId: rsvp.userId,
        fullName: user?.fullName ?? rsvp.userId,
        status: rsvp.status
      });
    }
    return roster;
  }

  async rsvp(eventId: string, userId: string): Promise<EventRsvp> {
    await this.chapterEvents.getById(eventId);
    const existing = (await this.rsvps.find({ eventId, userId }))[0];
    if (existing) {
      throw new ConflictException('Already RSVPed to this event');
    }
    const rsvp = await this.rsvps.create({
      id: newId('rsvp'),
      eventId,
      userId,
      status: 'rsvp',
      createdAt: new Date().toISOString()
    });
    await this.events.publish('chapters.event.rsvp', { eventId, userId });
    return rsvp;
  }

  /** Manual check-in by a lead/admin (no scanner metadata). */
  async recordAttendance(eventId: string, userId: string): Promise<EventRsvp> {
    await this.chapterEvents.getById(eventId);
    const existing = (await this.rsvps.find({ eventId, userId }))[0];
    if (existing?.status === 'attended') {
      throw new ConflictException('duplicate scan: member already checked in');
    }
    if (existing) {
      const updated = await this.rsvps.update(existing.id, { status: 'attended' });
      await this.events.publish('chapters.event.attended', { eventId, userId });
      return updated;
    }
    const created = await this.rsvps.create({
      id: newId('rsvp'),
      eventId,
      userId,
      status: 'attended',
      createdAt: new Date().toISOString()
    });
    await this.events.publish('chapters.event.attended', { eventId, userId });
    return created;
  }

  /* --------------------------- QR attendance --------------------------- */

  /** Issues the current-window signed code for an event. */
  async issueAttendanceCode(eventId: string): Promise<{ code: string; eventId: string; windowSeconds: number }> {
    await this.chapterEvents.getById(eventId);
    const window = Math.floor(Date.now() / 1000 / ATTENDANCE_WINDOW_SECONDS);
    return {
      code: signAttendanceCode(eventId, window),
      eventId,
      windowSeconds: ATTENDANCE_WINDOW_SECONDS
    };
  }

  /**
   * Verifies a scanned code and checks the member in. Accepts the current
   * window and the immediately preceding one (clock skew at boundaries).
   * Duplicate scans for the same member return 409.
   */
  async scanAttendance(eventId: string, code: string, memberId: string, scannerId: string): Promise<EventRsvp> {
    await this.chapterEvents.getById(eventId);
    const parts = code.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new BadRequestException('Malformed attendance code');
    }
    const [, codeEventId, windowText, signature] = parts;
    if (codeEventId !== eventId) {
      throw new UnauthorizedException('This code was issued for a different event');
    }
    const window = Number(windowText);
    const currentWindow = Math.floor(Date.now() / 1000 / ATTENDANCE_WINDOW_SECONDS);
    if (!Number.isInteger(window) || window < currentWindow - 1 || window > currentWindow) {
      throw new UnauthorizedException('Attendance code has expired — ask the lead for the current code');
    }
    const expected = signAttendanceCode(eventId, window).split('.')[3];
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid attendance code signature');
    }
    const existing = (await this.rsvps.find({ eventId, userId: memberId }))[0];
    if (existing?.status === 'attended') {
      throw new ConflictException('duplicate scan: member already checked in');
    }
    const scannedAt = new Date().toISOString();
    if (existing) {
      const updated = await this.rsvps.update(existing.id, {
        status: 'attended',
        scannedAt,
        scannerId
      });
      await this.events.publish('chapters.event.attended', { eventId, userId: memberId, via: 'qr' });
      return updated;
    }
    const created = await this.rsvps.create({
      id: newId('rsvp'),
      eventId,
      userId: memberId,
      status: 'attended',
      scannedAt,
      scannerId,
      createdAt: scannedAt
    });
    await this.events.publish('chapters.event.attended', { eventId, userId: memberId, via: 'qr' });
    return created;
  }

  /* ----------------------------- announcements ----------------------------- */

  listAnnouncements(chapterId: string): Promise<Announcement[]> {
    return this.announcements.find({ chapterId });
  }

  async createAnnouncement(chapterId: string, input: CreateAnnouncementInput): Promise<Announcement> {
    await this.chapters.getById(chapterId);
    const announcement = await this.announcements.create({
      id: newId('announcement'),
      chapterId,
      title: input.title,
      body: input.body,
      authorId: input.authorId,
      createdAt: new Date().toISOString()
    });
    await this.events.publish('chapters.announcement.created', { chapterId, announcementId: announcement.id });
    return announcement;
  }
}
