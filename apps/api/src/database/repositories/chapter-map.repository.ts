/**
 * Chapter Map persistence ports (Innovation 10, Stage 27 — migration 068,
 * geo_intel schema). Two read/write surfaces:
 *
 *  - ChapterMapSnapshotRepository: the recomputable aggregate cache
 *    (geo_intel.chapter_map_snapshots). Writes are idempotent upserts on the
 *    composite PK (chapter_id, h3_res7, metric); the source of truth stays
 *    in the domain tables.
 *  - ChapterMemberDirectory: a minimal READ port over the existing
 *    chapters.chapter_members roster (migration 001) so the aggregation
 *    service composes over geo-indexed data instead of re-implementing
 *    membership queries.
 *
 * Privacy invariant: snapshot rows are k-anonymised aggregates only — no
 * farmer identifiers, no raw coordinates. The pg contract test scans the
 * snapshot column set against a PII denylist.
 */

export const CHAPTER_MAP_METRICS = [
  'member_count',
  'plot_count',
  'plot_area_hectares',
  'voucher_redemptions',
  'mechanization_coverage',
  'pending_escrow_kobo'
] as const;
export type ChapterMapMetric = (typeof CHAPTER_MAP_METRICS)[number];

export function isChapterMapMetric(value: string): value is ChapterMapMetric {
  return (CHAPTER_MAP_METRICS as readonly string[]).includes(value);
}

/** One aggregate cell value — never carries member identity or raw lat/long. */
export interface ChapterMapSnapshot {
  chapterId: string;
  h3Res7: string;
  metric: ChapterMapMetric;
  valueNumeric: number;
  computedAt: string;
}

export interface ChapterMapSnapshotRepository {
  /**
   * Insert-or-replace keyed by (chapterId, h3Res7, metric): recompute runs
   * and duplicate deliveries stay safe. Returns the number of rows written.
   */
  upsertMany(snapshots: readonly ChapterMapSnapshot[]): Promise<number>;
  /** All snapshots for a chapter, optionally narrowed to one metric. */
  findByChapter(chapterId: string, metric?: ChapterMapMetric): Promise<ChapterMapSnapshot[]>;
}

/** Read-only roster port over chapters.chapter_members. */
export interface ChapterMemberDirectory {
  listMemberIds(chapterId: string): Promise<string[]>;
}

export function chapterMapSnapshotKey(snapshot: ChapterMapSnapshot): string {
  return `${snapshot.chapterId}|${snapshot.h3Res7}|${snapshot.metric}`;
}

export class InMemoryChapterMapSnapshotRepository implements ChapterMapSnapshotRepository {
  private readonly items = new Map<string, ChapterMapSnapshot>();

  constructor(seed: readonly ChapterMapSnapshot[] = []) {
    for (const snapshot of seed) {
      this.items.set(chapterMapSnapshotKey(snapshot), structuredClone(snapshot));
    }
  }

  async upsertMany(snapshots: readonly ChapterMapSnapshot[]): Promise<number> {
    for (const snapshot of snapshots) {
      this.items.set(chapterMapSnapshotKey(snapshot), structuredClone(snapshot));
    }
    return snapshots.length;
  }

  async findByChapter(chapterId: string, metric?: ChapterMapMetric): Promise<ChapterMapSnapshot[]> {
    return [...this.items.values()]
      .filter((snapshot) => snapshot.chapterId === chapterId && (!metric || snapshot.metric === metric))
      .map((snapshot) => structuredClone(snapshot));
  }
}

export class InMemoryChapterMemberDirectory implements ChapterMemberDirectory {
  /** chapterId -> member user ids. */
  constructor(private readonly roster: Readonly<Record<string, readonly string[]>> = {}) {}

  async listMemberIds(chapterId: string): Promise<string[]> {
    return [...(this.roster[chapterId] ?? [])];
  }
}

export function createInMemoryChapterMapSnapshotRepository(
  seed: readonly ChapterMapSnapshot[] = []
): InMemoryChapterMapSnapshotRepository {
  return new InMemoryChapterMapSnapshotRepository(seed);
}

export function createInMemoryChapterMemberDirectory(
  roster: Readonly<Record<string, readonly string[]>> = {}
): InMemoryChapterMemberDirectory {
  return new InMemoryChapterMemberDirectory(roster);
}
