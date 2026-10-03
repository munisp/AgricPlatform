import type pg from 'pg';
import type { Chapter, ChapterEvent, ChapterMember } from '@agric-platform/shared';
import {
  composeWhere,
  eq,
  PgRepositoryBase,
  type WhereClause
} from '../pg/pg-repository.base.js';
import { chapterEventMapper, chapterMapper, chapterMemberMapper } from '../pg/row-mappers.js';
import type {
  ChapterCriteria,
  ChapterEventCriteria,
  ChapterEventRepository,
  ChapterRepository
} from './chapter.repository.js';
import type { ChapterMemberRepository } from './chapter-member.repository.js';

export function chapterCriteriaSql(criteria: ChapterCriteria): WhereClause {
  return composeWhere(
    eq('state', criteria.state),
    eq('lga', criteria.lga),
    eq('ward', criteria.ward)
  );
}

export class PgChapterRepository
  extends PgRepositoryBase<Chapter, ChapterCriteria>
  implements ChapterRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'chapters.chapters',
      mapper: chapterMapper,
      criteria: chapterCriteriaSql
    });
  }
}

export function chapterEventCriteriaSql(criteria: ChapterEventCriteria): WhereClause {
  return composeWhere(eq('chapter_id', criteria.chapterId));
}

export class PgChapterEventRepository
  extends PgRepositoryBase<ChapterEvent, ChapterEventCriteria>
  implements ChapterEventRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'chapters.chapter_events',
      mapper: chapterEventMapper,
      criteria: chapterEventCriteriaSql,
      orderBy: 'starts_at'
    });
  }
}

/**
 * chapters.chapter_members writer path (GAP-M19). Adds are idempotent
 * upserts keyed by (chapter_id, user_id): a retried join keeps the
 * original joined_at and refreshes only the role.
 */
export class PgChapterMemberRepository implements ChapterMemberRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(chapterId: string): Promise<ChapterMember[]> {
    const result = await this.pool.query(
      `SELECT ${chapterMemberMapper.columns.join(', ')} FROM chapters.chapter_members
        WHERE chapter_id = $1 ORDER BY joined_at, user_id`,
      [chapterId]
    );
    return result.rows.map((row) => chapterMemberMapper.fromRow(row));
  }

  async find(chapterId: string, userId: string): Promise<ChapterMember | undefined> {
    const result = await this.pool.query(
      `SELECT ${chapterMemberMapper.columns.join(', ')} FROM chapters.chapter_members
        WHERE chapter_id = $1 AND user_id = $2`,
      [chapterId, userId]
    );
    return result.rows[0] ? chapterMemberMapper.fromRow(result.rows[0]) : undefined;
  }

  async add(member: ChapterMember): Promise<ChapterMember> {
    const result = await this.pool.query(
      `INSERT INTO chapters.chapter_members (chapter_id, user_id, role, joined_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (chapter_id, user_id)
       DO UPDATE SET role = EXCLUDED.role
       RETURNING ${chapterMemberMapper.columns.join(', ')}`,
      [member.chapterId, member.userId, member.role, member.joinedAt]
    );
    return chapterMemberMapper.fromRow(result.rows[0]);
  }

  async remove(chapterId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM chapters.chapter_members WHERE chapter_id = $1 AND user_id = $2',
      [chapterId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export function createPgChapterRepository(pool: pg.Pool): PgChapterRepository {
  return new PgChapterRepository(pool);
}

export function createPgChapterEventRepository(pool: pg.Pool): PgChapterEventRepository {
  return new PgChapterEventRepository(pool);
}

export function createPgChapterMemberRepository(pool: pg.Pool): PgChapterMemberRepository {
  return new PgChapterMemberRepository(pool);
}
