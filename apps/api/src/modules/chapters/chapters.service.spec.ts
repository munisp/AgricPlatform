import {
  BadRequestException,
  ConflictException,
  UnauthorizedException
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAnnouncementRepository } from '../../database/repositories/announcement.repository.js';
import { createInMemoryChapterEventRepository } from '../../database/repositories/chapter-event.repository.js';
import { createInMemoryChapterRepository } from '../../database/repositories/chapter.repository.js';
import { createInMemoryEventRsvpRepository } from '../../database/repositories/event-rsvp.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
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
