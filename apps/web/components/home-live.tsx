'use client';

import Link from 'next/link';
import { platformMetrics, seedAdvisory } from '@agric-platform/shared';
import { useApiQuery } from '@/lib/api/hooks';
import { fetchPlatformMetrics, listAdvisory } from '@/lib/api/endpoints';
import { MetricsGrid, StatusBadge } from '@/components/ui';
import { OfflineDataNotice, QueryState } from '@/components/api-state';

// Offline fallbacks only — live data from GET /api/v1/analytics/metrics and
// GET /api/v1/advisory.
const FALLBACK_METRICS = platformMetrics;
const FALLBACK_ADVISORY = seedAdvisory;

export function HomeMetrics() {
  const query = useApiQuery(
    'analytics:metrics:home',
    () => fetchPlatformMetrics().then((res) => res.data),
    { fallbackData: FALLBACK_METRICS, staleTimeMs: 60_000 }
  );
  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
      >
        <MetricsGrid metrics={query.data ?? []} />
      </QueryState>
    </>
  );
}

export function HomeAdvisory() {
  const query = useApiQuery(
    'advisory:home',
    () => listAdvisory({ pageSize: 6 }).then((res) => res.data),
    { fallbackData: FALLBACK_ADVISORY, staleTimeMs: 5 * 60_000 }
  );
  return (
    <>
      {query.source === 'fallback' ? (
        <OfflineDataNotice>Advisory feed offline — showing cached highlights.</OfflineDataNotice>
      ) : null}
      <ul className="row-list">
        {(query.data ?? []).map((item) => (
          <li className="row-item" key={item.id}>
            <div className="row-main">
              <div className="row-title">{item.title}</div>
              <div className="small muted">
                {[item.state, item.crop].filter(Boolean).join(' · ')}
              </div>
            </div>
            <StatusBadge tone={item.severity === 'warning' ? 'warning' : 'info'}>
              {item.kind.replace(/_/g, ' ')}
            </StatusBadge>
          </li>
        ))}
      </ul>
      <p style={{ marginTop: '1rem' }}>
        <Link href="/advisory">See all advisory →</Link>
      </p>
    </>
  );
}
