import { ServiceUnavailableException } from '@nestjs/common';
import type { PlatformMetric } from '@agric-platform/shared';
import { platformMetrics as seedFixtures } from '@agric-platform/shared';
import { isProduction } from '../../common/auth/auth.config.js';

/**
 * Live platform KPI composition (mockware fix): the hardcoded
 * platformMetrics fixture (10,482 members etc.) was served as real KPIs.
 * Every metric is now computed from repositories and labelled basis 'live'.
 * A metric whose backing repository is not wired carries the labelled seed
 * fixture (basis 'seed') and is REFUSED in production responses — no
 * unlabeled seed numbers ever leave the API.
 */

/** Repository-backed counts behind the platform KPIs (undefined = not wired). */
export interface PlatformMetricCounts {
  members?: number;
  activeChapters?: number;
  courseCompletions?: number;
  openOpportunities?: number;
  marketplaceListings?: number;
  creditProfiles?: number;
}

const METRIC_DEFS: ReadonlyArray<{
  key: string;
  label: string;
  count: keyof PlatformMetricCounts;
}> = [
  { key: 'members', label: 'Registered members', count: 'members' },
  { key: 'active_chapters', label: 'Active chapters', count: 'activeChapters' },
  { key: 'course_completions', label: 'Course completions', count: 'courseCompletions' },
  { key: 'opportunities', label: 'Open opportunities', count: 'openOpportunities' },
  { key: 'marketplace_listings', label: 'Marketplace listings', count: 'marketplaceListings' },
  { key: 'credit_profiles', label: 'Credit profiles', count: 'creditProfiles' }
];

/**
 * Composes the KPI list: live where a repository count exists, labelled
 * seed fixture otherwise. Trends are only carried on seed fixtures — a live
 * count without a trend basis does not fabricate one.
 */
export function composePlatformMetrics(counts: PlatformMetricCounts): PlatformMetric[] {
  return METRIC_DEFS.map((def) => {
    const value = counts[def.count];
    if (value !== undefined) {
      return { key: def.key, label: def.label, value, basis: 'live' };
    }
    const seed = seedFixtures.find((metric) => metric.key === def.key);
    return {
      key: def.key,
      label: def.label,
      value: seed?.value ?? 0,
      ...(seed?.trend !== undefined ? { trend: seed.trend } : {}),
      basis: 'seed'
    };
  });
}

/**
 * Fail closed (house doctrine): seed-basis metrics are fixtures and must
 * never appear in production responses — 503 instead of fabricated KPIs.
 */
export function assertNoSeedPlatformMetrics(metrics: PlatformMetric[]): void {
  if (!isProduction()) {
    return;
  }
  const seeded = metrics.filter((metric) => metric.basis === 'seed');
  if (seeded.length > 0) {
    throw new ServiceUnavailableException(
      `Platform metrics without a live basis (${seeded.map((metric) => metric.key).join(', ')}) ` +
        'are seed fixtures and are refused in production. Wire the backing repositories or ' +
        'remove the metric.'
    );
  }
}
