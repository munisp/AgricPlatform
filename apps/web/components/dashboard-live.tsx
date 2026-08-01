'use client';

import { platformMetrics } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiQuery } from '@/lib/api/hooks';
import { fetchPlatformMetrics, listNotifications } from '@/lib/api/endpoints';
import { demoNotifications } from '@/lib/content';
import { AutoBadge, MetricsGrid, Timeline } from '@/components/ui';
import { OfflineDataNotice, QueryState } from '@/components/api-state';

// Offline fallback only — live metrics come from GET /api/v1/analytics/metrics.
const FALLBACK_METRICS = platformMetrics.slice(0, 3);

export function LiveMetrics() {
  const query = useApiQuery(
    'analytics:metrics',
    () => fetchPlatformMetrics().then((res) => res.data.slice(0, 3)),
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

export function LiveNotifications() {
  const { userId, hydrated } = useAppState();
  const query = useApiQuery(
    hydrated ? `notifications:${userId}` : null,
    () => listNotifications(userId).then((res) => res.data),
    // Offline fallback only — live feed from GET /api/v1/notifications?userId=…
    { fallbackData: demoNotifications, enabled: hydrated }
  );
  const notifications = query.data ?? [];

  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={notifications}
        onRetry={query.refresh}
      >
        <div className="grid grid-2">
          <Timeline
            items={notifications.map((notif) => ({
              id: notif.id,
              title: notif.title,
              date: `${notif.channel.replace('_', ' ')} · ${new Date(notif.createdAt).toLocaleString('en-NG')}`,
              description: notif.body,
              tone: notif.status === 'queued' ? 'warning' : 'default'
            }))}
          />
          <div className="card">
            <h3>Delivery status</h3>
            <ul className="row-list">
              {notifications.map((notif) => (
                <li className="row-item" key={notif.id}>
                  <div className="row-main">
                    <div className="row-title">{notif.title}</div>
                    <div className="small muted">{notif.channel.replace('_', ' ')}</div>
                  </div>
                  <AutoBadge value={notif.status} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </QueryState>
    </>
  );
}
