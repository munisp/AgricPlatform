import { ConflictException } from '@nestjs/common';
import type pg from 'pg';
import type { Chapter, ChapterEvent } from '@agric-platform/shared';
import type { ChapterAnnouncement, EventRsvp } from '../seed-data.js';
import {
  composeWhere,
  eq,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import {
  announcementMapper,
  chapterEventMapper,
  chapterMapper,
  eventRsvpMapper
} from '../pg/row-mappers.js';
import type { AnnouncementCriteria, AnnouncementRepository } from './announcement.repository.js';
import type { ChapterEventCriteria, ChapterEventRepository } from './chapter-event.repository.js';
import type { ChapterCriteria, ChapterRepository } from './chapter.repository.js';
import type { EventRsvpCriteria, EventRsvpRepository } from './event-rsvp.repository.js';

export function chapterCriteriaSql(criteria: ChapterCriteria): WhereClause {
  return composeWhere(
    eq('level', criteria.level),
    eq('state', criteria.state),
    eq('parent_id', criteria.parentId)
  );
}

export class PgChapterRepository
  extends PgRepositoryBase<Chapter, ChapterCriteria>
  implements ChapterRepository
{
  constructor(pool: pg.Pool) {
    super(pool, { table: 'chapters.chapters', mapper: chapterMapper, criteria: chapterCriteriaSql });
  }
}

export function chapterEventCriteriaSql(criteria: ChapterEventCriteria): WhereClause {
  return composeWhere(eq('chapter_id', criteria.chapterId));
}

const EVENT_COLUMNS = chapterEventMapper.columns.join(', ');

export class PgChapterEventRepository
  extends PgRepositoryBase<ChapterEvent, ChapterEventCriteria>
  implements ChapterEventRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'chapters.events',
      mapper: chapterEventMapper,
      criteria: chapterEventCriteriaSql
    });
  }

  async incrementRsvp(id: string): Promise<ChapterEvent> {
    return this.incrementCounter(id, 'rsvp_count');
  }

  async incrementAttendance(id: string): Promise<ChapterEvent> {
    return this.incrementCounter(id, 'attendance_count');
  }

  private async incrementCounter(
    id: string,
    column: 'rsvp_count' | 'attendance_count'
  ): Promise<ChapterEvent> {
    const result = await this.pool.query(
      `UPDATE chapters.events SET ${column} = ${column} + 1
        WHERE id = $1 RETURNING ${EVENT_COLUMNS}`,
      [id]
    );
    if (!result.rows[0]) {
      return this.getById(id); // raises NotFoundException
    }
    return chapterEventMapper.fromRow(result.rows[0]);
  }
}

export function eventRsvpCriteriaSql(criteria: EventRsvpCriteria): WhereClause {
  return composeWhere(
    eq('event_id', criteria.eventId),
    eq('user_id', criteria.userId),
    eq('status', criteria.status)
  );
}

const RSVP_COLUMNS = eventRsvpMapper.columns.join(', ');

export class PgEventRsvpRepository
  extends PgRepositoryBase<EventRsvp, EventRsvpCriteria>
  implements EventRsvpRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'chapters.event_participation',
      mapper: eventRsvpMapper,
      criteria: eventRsvpCriteriaSql
    });
  }

  async findByEventAndUser(eventId: string, userId: string): Promise<EventRsvp | undefined> {
    return this.findOne({ eventId, userId });
  }

  /** RSVP insert + counter increment in one transaction (plan §10.15). */
  async recordRsvp(rsvp: EventRsvp): Promise<EventRsvp> {
    return this.withTransaction(async (client) => {
      const row = eventRsvpMapper.toRow(rsvp);
      const columns = Object.keys(row);
      try {
        await client.query(
          `INSERT INTO chapters.event_participation (${columns.join(', ')})
           VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
          columns.map((column) => row[column])
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ConflictException('User has already RSVPed to this event');
        }
        throw error;
      }
      await client.query(
        'UPDATE chapters.events SET rsvp_count = rsvp_count + 1 WHERE id = $1',
        [rsvp.eventId]
      );
      return rsvp;
    });
  }

  /** Attendance upsert + counter increment in one transaction. */
  async recordAttendance(rsvp: EventRsvp): Promise<EventRsvp> {
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO chapters.event_participation (id, event_id, user_id, status, created_at)
         VALUES ($1, $2, $3, 'attended', $4)
         ON CONFLICT (event_id, user_id) DO UPDATE SET status = 'attended'
         RETURNING ${RSVP_COLUMNS}`,
        [rsvp.id, rsvp.eventId, rsvp.userId, rsvp.createdAt]
      );
      await client.query(
        'UPDATE chapters.events SET attendance_count = attendance_count + 1 WHERE id = $1',
        [rsvp.eventId]
      );
      return eventRsvpMapper.fromRow(result.rows[0]);
    });
  }
}

export function announcementCriteriaSql(criteria: AnnouncementCriteria): WhereClause {
  return composeWhere(eq('chapter_id', criteria.chapterId));
}

export class PgAnnouncementRepository
  extends PgRepositoryBase<ChapterAnnouncement, AnnouncementCriteria>
  implements AnnouncementRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'chapters.announcements',
      mapper: announcementMapper,
      criteria: announcementCriteriaSql
    });
  }
}

export function createPgChapterRepository(pool: pg.Pool): PgChapterRepository {
  return new PgChapterRepository(pool);
}

export function createPgChapterEventRepository(pool: pg.Pool): PgChapterEventRepository {
  return new PgChapterEventRepository(pool);
}

export function createPgEventRsvpRepository(pool: pg.Pool): PgEventRsvpRepository {
  return new PgEventRsvpRepository(pool);
}

export function createPgAnnouncementRepository(pool: pg.Pool): PgAnnouncementRepository {
  return new PgAnnouncementRepository(pool);
}
