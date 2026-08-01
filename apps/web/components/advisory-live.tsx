'use client';

import { seedAdvisory } from '@agric-platform/shared';
import { useApiQuery } from '@/lib/api/hooks';
import { listAdvisory } from '@/lib/api/endpoints';
import { Card, StatusBadge } from '@/components/ui';
import { OfflineDataNotice, QueryState } from '@/components/api-state';

// Offline fallback only — live feed from GET /api/v1/advisory.
const FALLBACK_ADVISORY = seedAdvisory;

function severityTone(severity?: string) {
  if (severity === 'critical') return 'critical' as const;
  if (severity === 'warning') return 'warning' as const;
  return 'info' as const;
}

export function AdvisoryFeed() {
  const query = useApiQuery(
    'advisory:feed',
    () => listAdvisory({ pageSize: 30 }).then((res) => res.data),
    { fallbackData: FALLBACK_ADVISORY, staleTimeMs: 5 * 60_000 }
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
        <div className="grid grid-3">
          {(query.data ?? []).map((item) => (
            <Card key={item.id} title={item.title}>
              <p className="small muted">{item.summary}</p>
              <div className="cluster">
                <StatusBadge tone={severityTone(item.severity)}>{item.severity ?? 'info'}</StatusBadge>
                <StatusBadge tone="neutral">{item.kind.replace(/_/g, ' ')}</StatusBadge>
              </div>
              <p className="small muted" style={{ marginTop: '0.5rem' }}>
                {[item.state, item.crop].filter(Boolean).join(' · ')} ·{' '}
                {new Date(item.publishedAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
              </p>
            </Card>
          ))}
        </div>
      </QueryState>
    </>
  );
}
