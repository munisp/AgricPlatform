/**
 * Member segmentation (M13, Wave P5c). Pure aggregation functions over
 * user + profile records; the depth service supplies the data.
 *
 * Every segment reports an absolute count and a percentage of the segmented
 * population. Multi-valued dimensions (crop = farming interests) let a
 * member appear in several segments, so percentages can sum above 100 —
 * each is computed against the full member population, documented per field.
 */

export const SEGMENT_DIMENSIONS = ['state', 'crop', 'role', 'kyc_tier', 'cohort'] as const;
export type SegmentDimension = (typeof SEGMENT_DIMENSIONS)[number];

export interface SegmentBreakdown {
  key: string;
  count: number;
  /** count / total × 100, rounded to 2 decimals. */
  percentage: number;
}

export interface SegmentationResult {
  dimension: SegmentDimension;
  total: number;
  segments: SegmentBreakdown[];
}

/** Percentage of total, rounded to 2 decimals; 0 when total is 0. */
export function percentage(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 10000) / 100;
}

/**
 * Folds items into segments via `keysOf` (an item may yield zero, one or
 * many keys). Sorted by count descending, then key ascending.
 */
export function segmentCounts<T>(
  items: readonly T[],
  keysOf: (item: T) => string[],
  dimension: SegmentDimension
): SegmentationResult {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const key of new Set(keysOf(item))) {
      if (key.trim() === '') continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const segments = [...counts.entries()]
    .map(([key, count]) => ({ key, count, percentage: percentage(count, items.length) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return { dimension, total: items.length, segments };
}
