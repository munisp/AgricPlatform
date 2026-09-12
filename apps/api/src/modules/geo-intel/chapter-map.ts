import type {
  ChapterMapMetric,
  ChapterMapSnapshot
} from '../../database/repositories/chapter-map.repository.js';

/**
 * Chapter Map pure aggregation (Innovation 10, Stage 27). Deterministic,
 * known-answer-testable composition over geo-indexed platform data — the
 * service layer gathers the source rows from the existing repositories and
 * this module reduces them to per-chapter H3 res-7 metric cells. No I/O, no
 * h3-js import here: coarser-resolution service-area coverage is resolved
 * through the injected `cellParent` (H3Service.parentAt) so the geo module
 * stays the only place the H3 library is imported.
 */

/**
 * k-anonymity floor (hard privacy invariant): cells whose member count is
 * below this threshold are SUPPRESSED from API responses — no farmer-level
 * signal ever leaks through the map surface.
 */
export const K_ANONYMITY_FLOOR = 5;

/** Snapshot freshness TTL: past this, reads are served with stale=true. */
export const CHAPTER_MAP_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

export interface MemberCell {
  userId: string;
  /** Member's res-7 cell from the geo.h3_index profile entry. */
  cell: string;
}

export interface PlotCell {
  id: string;
  ownerUserId: string;
  cell: string;
  sizeHectares: number;
}

export interface MemberRedemption {
  id: string;
  farmerId: string;
}

export interface ServiceArea {
  id: string;
  /** Cells at `resolution` (5-7) the listing serves. */
  cells: readonly string[];
  resolution: number;
}

export interface PendingEscrow {
  id: string;
  sellerId: string;
  amountKobo: number;
}

export interface ChapterMapSourceData {
  chapterId: string;
  /** Chapter members that have a geo-indexed profile cell. */
  memberCells: readonly MemberCell[];
  /** Member-owned plots with their res-7 cell. */
  plots: readonly PlotCell[];
  /** Redemptions by member farmers (any programme). */
  redemptions: readonly MemberRedemption[];
  /** Active mechanization listings' service areas. */
  serviceAreas: readonly ServiceArea[];
  /** Held escrows whose seller is a chapter member. */
  pendingEscrows: readonly PendingEscrow[];
}

/** Resolves a cell's ancestor at a coarser resolution (H3Service.parentAt). */
export type CellParentFn = (cell: string, resolution: number) => string;

function addCellMetric(
  cells: Map<string, Map<ChapterMapMetric, number>>,
  cell: string,
  metric: ChapterMapMetric,
  value: number
): void {
  let metrics = cells.get(cell);
  if (!metrics) {
    metrics = new Map<ChapterMapMetric, number>();
    cells.set(cell, metrics);
  }
  metrics.set(metric, (metrics.get(metric) ?? 0) + value);
}

/**
 * Reduces source rows to per-cell metric values. Cells appear when any
 * metric is non-zero; attribution of vouchers/escrows/plots follows the
 * MEMBER's geo-indexed profile cell (records carry no coordinates of their
 * own, so member-less or unindexed rows are honestly skipped, never
 * re-attributed by guesswork).
 */
export function aggregateChapterMap(
  source: ChapterMapSourceData,
  cellParent: CellParentFn
): Map<string, Map<ChapterMapMetric, number>> {
  const cells = new Map<string, Map<ChapterMapMetric, number>>();
  const memberSet = new Set(source.memberCells.map((member) => member.userId));
  const memberCell = new Map<string, string>();
  for (const member of source.memberCells) {
    memberCell.set(member.userId, member.cell);
    addCellMetric(cells, member.cell, 'member_count', 1);
  }

  for (const plot of source.plots) {
    if (!memberSet.has(plot.ownerUserId)) {
      continue;
    }
    addCellMetric(cells, plot.cell, 'plot_count', 1);
    addCellMetric(cells, plot.cell, 'plot_area_hectares', plot.sizeHectares);
  }

  for (const redemption of source.redemptions) {
    const cell = memberCell.get(redemption.farmerId);
    if (!cell) {
      continue;
    }
    addCellMetric(cells, cell, 'voucher_redemptions', 1);
  }

  for (const escrow of source.pendingEscrows) {
    const cell = memberCell.get(escrow.sellerId);
    if (!cell) {
      continue;
    }
    addCellMetric(cells, cell, 'pending_escrow_kobo', escrow.amountKobo);
  }

  // Mechanization coverage: for every cell the chapter occupies, count the
  // active listings whose service area covers it. Service areas at res 5/6
  // cover a res-7 cell when they contain its ancestor at that resolution.
  const occupiedCells = [...cells.keys()];
  for (const area of source.serviceAreas) {
    const served = new Set(area.cells);
    for (const cell of occupiedCells) {
      const covered =
        area.resolution === 7 ? served.has(cell) : served.has(cellParent(cell, area.resolution));
      if (covered) {
        addCellMetric(cells, cell, 'mechanization_coverage', 1);
      }
    }
  }

  return cells;
}

/** Flattens the aggregation to snapshot rows (computedAt stamped by the caller). */
export function chapterMapSnapshots(
  chapterId: string,
  cells: ReadonlyMap<string, ReadonlyMap<ChapterMapMetric, number>>,
  computedAt: string
): ChapterMapSnapshot[] {
  const rows: ChapterMapSnapshot[] = [];
  for (const [h3Res7, metrics] of [...cells.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [metric, valueNumeric] of [...metrics.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      rows.push({ chapterId, h3Res7, metric, valueNumeric, computedAt });
    }
  }
  return rows;
}

export interface KAnonymityResult {
  /** Cells at or above the floor; everything below the floor is ABSENT. */
  rows: ChapterMapSnapshot[];
  /** Number of distinct cells suppressed (transparency without leakage). */
  suppressedCellCount: number;
}

/**
 * Applies the k-anonymity floor to snapshot rows: a cell is visible only
 * when its member_count reaches the floor; below it the cell is removed
 * from EVERY metric so no farmer-level signal leaks through.
 */
export function applyKAnonymity(
  rows: readonly ChapterMapSnapshot[],
  floor: number = K_ANONYMITY_FLOOR
): KAnonymityResult {
  const memberCountByCell = new Map<string, number>();
  for (const row of rows) {
    if (row.metric === 'member_count') {
      memberCountByCell.set(row.h3Res7, row.valueNumeric);
    }
  }
  const visible = new Set<string>();
  const suppressed = new Set<string>();
  for (const row of rows) {
    const members = memberCountByCell.get(row.h3Res7) ?? 0;
    if (members >= floor) {
      visible.add(row.h3Res7);
    } else {
      suppressed.add(row.h3Res7);
    }
  }
  return {
    rows: rows.filter((row) => visible.has(row.h3Res7)),
    suppressedCellCount: suppressed.size
  };
}

/** Honest staleness: snapshots older than the TTL are served stale=true. */
export function isSnapshotStale(
  computedAt: string | null,
  nowMs: number,
  ttlMs: number = CHAPTER_MAP_SNAPSHOT_TTL_MS
): boolean {
  if (computedAt === null) {
    return true;
  }
  const computedMs = Date.parse(computedAt);
  if (!Number.isFinite(computedMs)) {
    return true;
  }
  return nowMs - computedMs > ttlMs;
}
