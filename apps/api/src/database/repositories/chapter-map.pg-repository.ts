import type pg from 'pg';
import { num, ts } from '../pg/pg-repository.base.js';
import {
  isChapterMapMetric,
  type ChapterMapMetric,
  type ChapterMapSnapshot,
  type ChapterMapSnapshotRepository,
  type ChapterMemberDirectory
} from './chapter-map.repository.js';

/**
 * Chapter Map pg implementations (Innovation 10, Stage 27 — migration 068).
 * upsertMany batches a multi-row INSERT ... ON CONFLICT on the composite PK
 * (chapter_id, h3_res7, metric), so recompute runs are idempotent by
 * construction; the latest computed_at always wins (recomputable cache —
 * the domain tables remain the source of truth).
 */

/** Max rows per INSERT statement (5 params per row, well under the 65535 bind limit). */
export const CHAPTER_MAP_UPSERT_BATCH = 500;

function snapshotFromRow(row: Record<string, unknown>): ChapterMapSnapshot {
  const metric = row.metric as string;
  if (!isChapterMapMetric(metric)) {
    // Fail closed: a row outside the metric enum (schema drift) is never
    // surfaced as a map value.
    throw new Error(`chapter_map_snapshots row carries unknown metric '${metric}'`);
  }
  return {
    chapterId: row.chapter_id as string,
    h3Res7: row.h3_res7 as string,
    metric,
    valueNumeric: num(row.value_numeric),
    computedAt: ts(row.computed_at)
  };
}

export class PgChapterMapSnapshotRepository implements ChapterMapSnapshotRepository {
  constructor(private readonly pool: pg.Pool) {}

  async upsertMany(snapshots: readonly ChapterMapSnapshot[]): Promise<number> {
    let written = 0;
    for (let start = 0; start < snapshots.length; start += CHAPTER_MAP_UPSERT_BATCH) {
      const batch = snapshots.slice(start, start + CHAPTER_MAP_UPSERT_BATCH);
      const params: unknown[] = [];
      const tuples = batch
        .map((snapshot, index) => {
          const base = index * 5;
          params.push(
            snapshot.chapterId,
            snapshot.h3Res7,
            snapshot.metric,
            snapshot.valueNumeric,
            snapshot.computedAt
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
        })
        .join(', ');
      await this.pool.query(
        `INSERT INTO geo_intel.chapter_map_snapshots
           (chapter_id, h3_res7, metric, value_numeric, computed_at)
         VALUES ${tuples}
         ON CONFLICT (chapter_id, h3_res7, metric)
         DO UPDATE SET value_numeric = EXCLUDED.value_numeric,
                       computed_at = EXCLUDED.computed_at`,
        params
      );
      written += batch.length;
    }
    return written;
  }

  async findByChapter(chapterId: string, metric?: ChapterMapMetric): Promise<ChapterMapSnapshot[]> {
    const result = metric
      ? await this.pool.query(
          `SELECT chapter_id, h3_res7, metric, value_numeric, computed_at
           FROM geo_intel.chapter_map_snapshots
           WHERE chapter_id = $1 AND metric = $2
           ORDER BY h3_res7, metric`,
          [chapterId, metric]
        )
      : await this.pool.query(
          `SELECT chapter_id, h3_res7, metric, value_numeric, computed_at
           FROM geo_intel.chapter_map_snapshots
           WHERE chapter_id = $1
           ORDER BY h3_res7, metric`,
          [chapterId]
        );
    return result.rows.map(snapshotFromRow);
  }
}

/** Read-only roster over chapters.chapter_members (migration 001). */
export class PgChapterMemberDirectory implements ChapterMemberDirectory {
  constructor(private readonly pool: pg.Pool) {}

  async listMemberIds(chapterId: string): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT user_id FROM chapters.chapter_members WHERE chapter_id = $1 ORDER BY user_id`,
      [chapterId]
    );
    return result.rows.map((row) => row.user_id as string);
  }
}

export function createPgChapterMapSnapshotRepository(pool: pg.Pool): PgChapterMapSnapshotRepository {
  return new PgChapterMapSnapshotRepository(pool);
}

export function createPgChapterMemberDirectory(pool: pg.Pool): PgChapterMemberDirectory {
  return new PgChapterMemberDirectory(pool);
}
