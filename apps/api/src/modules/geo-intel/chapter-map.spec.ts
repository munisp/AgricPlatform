import { describe, expect, it } from 'vitest';
import {
  aggregateChapterMap,
  applyKAnonymity,
  CHAPTER_MAP_SNAPSHOT_TTL_MS,
  chapterMapSnapshots,
  isSnapshotStale,
  K_ANONYMITY_FLOOR,
  type ChapterMapSourceData
} from './chapter-map.js';

/**
 * Chapter Map pure-aggregation known-answer tests (Innovation 10, Stage 27).
 * Deterministic fixture cells (valid H3 shapes are irrelevant here — the
 * injected cellParent stub resolves the res-5 ancestor by prefix), so the
 * expected values are computed by hand and asserted exactly.
 */

const CELL_A = '87581b966ffffff'; // Zaria res-7 (ground truth in h3.service.spec)
const CELL_A_RES5 = '85581b97fffffff';
const CELL_B = '87580a4edffffff'; // Kano res-7
// Real res-5 parent of CELL_B (pentagon-edge Kano): verified via h3-js.
const CELL_B_RES5 = '85580a4ffffffff';

/** Stub ancestor resolver standing in for H3Service.parentAt. */
const cellParent = (cell: string, resolution: number): string => {
  if (resolution === 7) return cell;
  if (resolution === 5) {
    if (cell === CELL_A) return CELL_A_RES5;
    if (cell === CELL_B) return CELL_B_RES5;
  }
  throw new Error(`unexpected cellParent(${cell}, ${resolution})`);
};

function fixtureSource(overrides: Partial<ChapterMapSourceData> = {}): ChapterMapSourceData {
  return {
    chapterId: 'ch-1',
    memberCells: [
      { userId: 'u1', cell: CELL_A },
      { userId: 'u2', cell: CELL_A },
      { userId: 'u3', cell: CELL_A },
      { userId: 'u4', cell: CELL_A },
      { userId: 'u5', cell: CELL_A },
      { userId: 'u6', cell: CELL_B },
      { userId: 'u7', cell: CELL_B }
    ],
    plots: [
      { id: 'p1', ownerUserId: 'u1', cell: CELL_A, sizeHectares: 1.5 },
      { id: 'p2', ownerUserId: 'u2', cell: CELL_A, sizeHectares: 2.5 },
      { id: 'p3', ownerUserId: 'u6', cell: CELL_B, sizeHectares: 3 },
      { id: 'p4', ownerUserId: 'ux-not-a-member', cell: CELL_A, sizeHectares: 9 }
    ],
    redemptions: [
      { id: 'r1', farmerId: 'u1' },
      { id: 'r2', farmerId: 'u3' },
      { id: 'r3', farmerId: 'u7' },
      { id: 'r4', farmerId: 'ux-not-a-member' }
    ],
    serviceAreas: [
      { id: 'l1', cells: [CELL_A], resolution: 7 },
      { id: 'l2', cells: [CELL_B_RES5], resolution: 5 },
      { id: 'l3', cells: ['87581b964ffffff'], resolution: 7 } // covers nothing
    ],
    pendingEscrows: [
      { id: 'e1', sellerId: 'u1', amountKobo: 500_000 },
      { id: 'e2', sellerId: 'u2', amountKobo: 250_000 },
      { id: 'e3', sellerId: 'u6', amountKobo: 100_000 },
      { id: 'e4', sellerId: 'ux-not-a-member', amountKobo: 9_999 }
    ],
    ...overrides
  };
}

describe('aggregateChapterMap (known answer)', () => {
  it('reduces fixture rows to exact per-cell metrics', () => {
    const cells = aggregateChapterMap(fixtureSource(), cellParent);

    const cellA = cells.get(CELL_A);
    expect(cellA?.get('member_count')).toBe(5);
    expect(cellA?.get('plot_count')).toBe(2); // non-member plot p4 ignored
    expect(cellA?.get('plot_area_hectares')).toBe(4);
    expect(cellA?.get('voucher_redemptions')).toBe(2); // non-member r4 ignored
    expect(cellA?.get('pending_escrow_kobo')).toBe(750_000); // non-member e4 ignored
    expect(cellA?.get('mechanization_coverage')).toBe(1); // l1 at res 7

    const cellB = cells.get(CELL_B);
    expect(cellB?.get('member_count')).toBe(2);
    expect(cellB?.get('plot_count')).toBe(1);
    expect(cellB?.get('plot_area_hectares')).toBe(3);
    expect(cellB?.get('voucher_redemptions')).toBe(1);
    expect(cellB?.get('pending_escrow_kobo')).toBe(100_000);
    expect(cellB?.get('mechanization_coverage')).toBe(1); // l2 via res-5 ancestor

    expect(cells.size).toBe(2); // l3's uncovered cell never appears
  });

  it('produces an empty map for a chapter with no geo-indexed members', () => {
    const cells = aggregateChapterMap(
      fixtureSource({ memberCells: [], plots: [], redemptions: [], pendingEscrows: [] }),
      cellParent
    );
    expect(cells.size).toBe(0);
  });

  it('flattens to deterministic, sorted snapshot rows', () => {
    const cells = aggregateChapterMap(fixtureSource(), cellParent);
    const rows = chapterMapSnapshots('ch-1', cells, '2026-09-15T00:00:00.000Z');
    // 6 metrics in cell A + 6 in cell B, sorted by (cell, metric).
    expect(rows).toHaveLength(12);
    // CELL_B sorts before CELL_A ('87580...' < '87581...'); within a cell,
    // 'mechanization_coverage' sorts before 'member_count'.
    expect(rows[0]).toEqual({
      chapterId: 'ch-1',
      h3Res7: CELL_B,
      metric: 'mechanization_coverage',
      valueNumeric: 1,
      computedAt: '2026-09-15T00:00:00.000Z'
    });
    const keys = rows.map((row) => `${row.h3Res7}:${row.metric}`);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('applyKAnonymity (hard privacy invariant)', () => {
  const cells = aggregateChapterMap(fixtureSource(), cellParent);
  const rows = chapterMapSnapshots('ch-1', cells, '2026-09-15T00:00:00.000Z');

  it('suppresses every metric of cells below the floor', () => {
    const { rows: visible, suppressedCellCount } = applyKAnonymity(rows);
    expect(suppressedCellCount).toBe(1); // CELL_B has 2 members < 5
    expect(visible).toHaveLength(6);
    expect(visible.every((row) => row.h3Res7 === CELL_A)).toBe(true);
    // Nothing from the suppressed cell leaks, not even its member_count.
    expect(visible.some((row) => row.h3Res7 === CELL_B)).toBe(false);
  });

  it('keeps a cell exactly at the floor (boundary)', () => {
    const atFloor = rows.map((row) =>
      row.h3Res7 === CELL_B && row.metric === 'member_count'
        ? { ...row, valueNumeric: K_ANONYMITY_FLOOR }
        : row
    );
    const { rows: visible, suppressedCellCount } = applyKAnonymity(atFloor);
    expect(suppressedCellCount).toBe(0);
    expect(visible).toHaveLength(12);
  });

  it('suppresses cells with no member_count row at all (zero members)', () => {
    const noMembers = rows.filter((row) => row.metric !== 'member_count');
    const { rows: visible, suppressedCellCount } = applyKAnonymity(noMembers);
    expect(visible).toHaveLength(0);
    expect(suppressedCellCount).toBe(2);
  });
});

describe('isSnapshotStale (fail-closed honesty)', () => {
  const NOW = Date.parse('2026-09-15T12:00:00.000Z');

  it('is fresh inside the TTL and stale past it', () => {
    expect(isSnapshotStale('2026-09-15T07:00:00.000Z', NOW)).toBe(false); // 5h old
    expect(isSnapshotStale('2026-09-15T06:00:00.000Z', NOW)).toBe(false); // exactly TTL: not past
    expect(isSnapshotStale('2026-09-15T05:59:59.000Z', NOW)).toBe(true); // past TTL
  });

  it('treats never-computed and unparseable snapshots as stale', () => {
    expect(isSnapshotStale(null, NOW)).toBe(true);
    expect(isSnapshotStale('not-a-date', NOW)).toBe(true);
    expect(CHAPTER_MAP_SNAPSHOT_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });
});
