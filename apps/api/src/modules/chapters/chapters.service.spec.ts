import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAnnouncementRepository } from '../../database/repositories/announcement.repository.js';
import { createInMemoryChapterEventRepository } from '../../database/repositories/chapter-event.repository.js';
import { createInMemoryChapterMemberRepository } from '../../database/repositories/chapter-member.repository.js';
import { createInMemoryChapterRepository } from '../../database/repositories/chapter.repository.js';
import { createInMemoryEventRsvpRepository } from '../../database/repositories/event-rsvp.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { ChaptersService } from './chapters.service.js';

const EVENT_ID = 'event-kaduna-training'; // seeded chapter event
const MEMBER = 'user-aisha';
const SCANNER = 'user-admin';

function makeService() {
  const events = createInMemoryChapterEventRepository();
  const rsvps = createInMemoryEventRsvpRepository(events);
  const chapters = new ChaptersService(
    new DomainEventsService(createInMemoryOutboxRepository()),
    createInMemoryChapterRepository(),
    createInMemoryChapterMemberRepository(),
    events,
    rsvps,
    createInMemoryAnnouncementRepository()
  );
  return { chapters, rsvps, events };
}

describe('ChaptersService QR attendance', () => {
  it('issues a code and accepts a valid scan, recording scanner metadata', async () => {
    const { chapters } = makeService();
    const issued = await chapters.issueAttendanceCode(EVENT_ID);
    expect(issued.code.startsWith('v1.')).toBe(true);
    expect(issued.eventId).toBe(EVENT_ID);

    const record = await chapters.scanAttendance(EVENT_ID, issued.code, MEMBER, SCANNER);
    expect(record.status).toBe('attended');
    expect(record.userId).toBe(MEMBER);
    expect(record.scannerId).toBe(SCANNER);
    expect(record.scannedAt).toBeDefined();
  });

  it('rejects a duplicate scan with 409 (member+event)', async () => {
    const { chapters } = makeService();
    const issued = await chapters.issueAttendanceCode(EVENT_ID);
    await chapters.scanAttendance(EVENT_ID, issued.code, MEMBER, SCANNER);
    await expect(chapters.scanAttendance(EVENT_ID, issued.code, MEMBER, SCANNER)).rejects.toThrowError(
      ConflictException
    );
    await expect(chapters.scanAttendance(EVENT_ID, issued.code, MEMBER, SCANNER)).rejects.toThrowError(
      /duplicate scan/
    );
    // A different member can still check in with the same event code.
    const other = await chapters.scanAttendance(EVENT_ID, issued.code, 'user-adamu', SCANNER);
    expect(other.userId).toBe('user-adamu');
  });

  it('rejects forged signatures with 401', async () => {
    const { chapters } = makeService();
    const issued = await chapters.issueAttendanceCode(EVENT_ID);
    const forged = `${issued.code.slice(0, -2)}${issued.code.endsWith('a') ? 'b' : 'a'}x`;
    await expect(chapters.scanAttendance(EVENT_ID, forged, MEMBER, SCANNER)).rejects.toThrowError(
      UnauthorizedException
    );
  });

  it('rejects codes issued for a different event with 401', async () => {
    const { chapters } = makeService();
    const otherEvent = await chapters.createEvent(
      'chapter-kaduna',
      { title: 'Second event', type: 'meeting', startsAt: '2026-09-01T09:00:00.000Z', location: 'Zaria' },
      SCANNER
    );
    const foreignCode = await chapters.issueAttendanceCode(otherEvent.id);
    await expect(
      chapters.scanAttendance(EVENT_ID, foreignCode.code, MEMBER, SCANNER)
    ).rejects.toThrowError(UnauthorizedException);
  });

  it('rejects malformed codes with 400', async () => {
    const { chapters } = makeService();
    await expect(chapters.scanAttendance(EVENT_ID, 'not-a-code', MEMBER, SCANNER)).rejects.toThrowError(
      BadRequestException
    );
  });

  it('keeps manual check-in (no scanner) distinct from QR scans', async () => {
    const { chapters } = makeService();
    const record = await chapters.recordAttendance(EVENT_ID, MEMBER);
    expect(record.status).toBe('attended');
    expect(record.scannerId).toBeUndefined();
    await expect(chapters.recordAttendance(EVENT_ID, MEMBER)).rejects.toThrowError(ConflictException);
  });
});

describe('ChaptersService event roster (G7)', () => {
  it('returns the RSVP roster joined with real member names', async () => {
    const events = createInMemoryChapterEventRepository();
    const rsvps = createInMemoryEventRsvpRepository(events);
    const chapters = new ChaptersService(
      new DomainEventsService(createInMemoryOutboxRepository()),
      createInMemoryChapterRepository(),
      createInMemoryChapterMemberRepository(),
      events,
      rsvps,
      createInMemoryAnnouncementRepository(),
      createInMemoryUserRepository()
    );
    const roster = await chapters.eventRoster(EVENT_ID);
    // Seed RSVP: user-adamu -> Adamu Bello.
    expect(roster).toEqual([
      { userId: 'user-adamu', fullName: 'Adamu Bello', status: 'rsvp' }
    ]);
  });

  it('marks roster rows attended after check-in and rejects unknown events', async () => {
    const events = createInMemoryChapterEventRepository();
    const rsvps = createInMemoryEventRsvpRepository(events);
    const chapters = new ChaptersService(
      new DomainEventsService(createInMemoryOutboxRepository()),
      createInMemoryChapterRepository(),
      createInMemoryChapterMemberRepository(),
      events,
      rsvps,
      createInMemoryAnnouncementRepository(),
      createInMemoryUserRepository()
    );
    await chapters.recordAttendance(EVENT_ID, 'user-adamu');
    const roster = await chapters.eventRoster(EVENT_ID);
    expect(roster[0]?.status).toBe('attended');
    await expect(chapters.eventRoster('event-missing')).rejects.toThrow();
  });
});

describe('ChaptersService membership writes (GAP-M19)', () => {
  function makeMembershipService() {
    const events = createInMemoryChapterEventRepository();
    const rsvps = createInMemoryEventRsvpRepository(events);
    const members = createInMemoryChapterMemberRepository();
    const chapters = new ChaptersService(
      new DomainEventsService(createInMemoryOutboxRepository()),
      createInMemoryChapterRepository(),
      members,
      events,
      rsvps,
      createInMemoryAnnouncementRepository(),
      createInMemoryUserRepository()
    );
    return { chapters, members };
  }

  it('adds a member and lists the roster with role + joinedAt', async () => {
    const { chapters } = makeMembershipService();
    const member = await chapters.addMember('chapter-kaduna', MEMBER, 'secretary');
    expect(member).toMatchObject({
      chapterId: 'chapter-kaduna',
      userId: MEMBER,
      role: 'secretary'
    });
    expect(member.joinedAt).toBeTruthy();
    const roster = await chapters.listMembers('chapter-kaduna');
    expect(roster).toHaveLength(1);
    expect(roster[0].userId).toBe(MEMBER);
  });

  it('defaults the role to member and upserts on a repeated join', async () => {
    const { chapters } = makeMembershipService();
    const first = await chapters.addMember('chapter-kaduna', MEMBER);
    expect(first.role).toBe('member');
    const again = await chapters.addMember('chapter-kaduna', MEMBER, 'lead');
    expect(again.role).toBe('lead');
    expect(again.joinedAt).toBe(first.joinedAt);
    expect(await chapters.listMembers('chapter-kaduna')).toHaveLength(1);
  });

  it('removes a member and 404s when the membership does not exist', async () => {
    const { chapters } = makeMembershipService();
    await chapters.addMember('chapter-kaduna', MEMBER);
    await expect(chapters.removeMember('chapter-kaduna', MEMBER)).resolves.toEqual({
      removed: true
    });
    expect(await chapters.listMembers('chapter-kaduna')).toHaveLength(0);
    await expect(chapters.removeMember('chapter-kaduna', MEMBER)).rejects.toThrowError(
      NotFoundException
    );
  });

  it('404s membership writes against unknown chapters and unknown users', async () => {
    const { chapters } = makeMembershipService();
    await expect(chapters.addMember('chapter-missing', MEMBER)).rejects.toThrowError(
      NotFoundException
    );
    await expect(
      chapters.addMember('chapter-kaduna', 'user-missing')
    ).rejects.toThrowError(NotFoundException);
    await expect(chapters.listMembers('chapter-missing')).rejects.toThrowError(
      NotFoundException
    );
  });
});

describe('ChaptersService event/chapter detail columns (GAP-L12)', () => {
  it('persists description, endsAt and createdBy on event creation', async () => {
    const { chapters } = makeService();
    const event = await chapters.createEvent('chapter-kaduna', {
      title: 'Wet-season planning',
      type: 'meeting',
      startsAt: '2026-05-01T09:00:00.000Z',
      endsAt: '2026-05-01T11:00:00.000Z',
      location: 'Kaduna Secretariat',
      description: 'Agenda: input distribution and planting windows.'
    }, 'user-lead-kaduna');
    expect(event.description).toBe('Agenda: input distribution and planting windows.');
    expect(event.endsAt).toBe('2026-05-01T11:00:00.000Z');
    expect(event.createdBy).toBe('user-lead-kaduna');
    const stored = await chapters.getEvent(event.id);
    expect(stored.createdBy).toBe('user-lead-kaduna');
    expect(stored.endsAt).toBe('2026-05-01T11:00:00.000Z');
  });

  it('persists the ward on chapter creation', async () => {
    const { chapters } = makeService();
    const chapter = await chapters.create({
      name: 'Kawo Ward Chapter',
      level: 'ward',
      state: 'Kaduna',
      lga: 'Kaduna North',
      ward: 'Kawo'
    });
    expect(chapter.ward).toBe('Kawo');
  });
});
