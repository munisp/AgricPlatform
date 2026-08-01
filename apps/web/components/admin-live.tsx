'use client';

import { platformMetrics } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useApiQuery } from '@/lib/api/hooks';
import { adminAudit, adminKpis, adminListUsers, adminReviewQueue } from '@/lib/api/endpoints';
import { demoAuditEvents, reviewQueue } from '@/lib/content';
import { AutoBadge, MetricsGrid, StatusBadge } from '@/components/ui';
import { OfflineDataNotice, QueryState } from '@/components/api-state';

// Offline fallbacks only — admin surfaces are role-gated at the API; when the
// caller lacks the admin role the API returns 403 and the UI shows a
// no-access state instead of fixtures.
const FALLBACK_KPIS = platformMetrics;

export function AdminKpis() {
  const query = useApiQuery('admin:kpis', () => adminKpis().then((res) => res.data), {
    fallbackData: FALLBACK_KPIS,
    staleTimeMs: 60_000
  });
  return (
    <>
      {query.source === 'fallback' && query.error ? (
        <OfflineDataNotice>Admin KPIs unavailable — showing reference metrics.</OfflineDataNotice>
      ) : null}
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

export function AdminReviewQueueTable() {
  const query = useApiQuery('admin:review-queue', () => adminReviewQueue().then((res) => res.data), {
    staleTimeMs: 30_000
  });

  if (query.error) {
    return (
      <>
        {/* Fixture fallback keeps the operator layout reviewable offline. */}
        <OfflineDataNotice>Live review queue unavailable — showing reference items.</OfflineDataNotice>
        <ReviewTable
          items={reviewQueue.map((item) => ({
            id: item.id,
            type: item.kind,
            summary: item.subject,
            priority: item.priority
          }))}
        />
      </>
    );
  }

  return (
    <QueryState
      isLoading={query.isLoading}
      error={undefined}
      data={query.data?.items ?? []}
      onRetry={query.refresh}
    >
      {query.data ? (
        <>
          <p className="small muted">
            {query.data.flaggedTopics} flagged topics · {query.data.pendingDocuments} pending documents ·{' '}
            {query.data.pendingApplications} pending applications
          </p>
          <ReviewTable
            items={query.data.items.map((item) => ({
              id: item.id,
              type: item.type.replace(/_/g, ' '),
              summary: item.summary,
              priority: 'medium'
            }))}
          />
        </>
      ) : null}
    </QueryState>
  );
}

function ReviewTable({
  items
}: {
  items: Array<{ id: string; type: string; summary: string; priority: string }>;
}) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Type</th>
            <th>Priority</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{item.summary}</td>
              <td>{item.type}</td>
              <td>
                <StatusBadge
                  tone={
                    item.priority === 'high'
                      ? 'critical'
                      : item.priority === 'medium'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {item.priority}
                </StatusBadge>
              </td>
              <td>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  disabled
                  title="Detail workflow ships with the operations wave"
                >
                  Open
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminAuditList() {
  const query = useApiQuery('admin:audit', () => adminAudit().then((res) => res.data), {
    fallbackData: demoAuditEvents
  });
  return (
    <>
      {query.source === 'fallback' && query.error ? (
        <OfflineDataNotice>Audit log unavailable — showing reference events.</OfflineDataNotice>
      ) : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
      >
        <ul className="row-list">
          {(query.data ?? []).map((event) => (
            <li className="row-item" key={event.id}>
              <div className="row-main">
                <div className="row-title">{event.action}</div>
                <div className="small muted">
                  {event.entityType} #{event.entityId} · actor {event.actorId} ·{' '}
                  {new Date(event.createdAt).toLocaleString('en-NG')}
                </div>
              </div>
              <AutoBadge value="recorded" />
            </li>
          ))}
        </ul>
      </QueryState>
    </>
  );
}

export function AdminUserList() {
  const { role } = useAppState();
  const query = useApiQuery(
    `admin:users:${role}`,
    () => adminListUsers({ pageSize: 10 }).then((res) => res.data),
    { staleTimeMs: 60_000 }
  );
  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.error}
      data={query.data}
      onRetry={query.refresh}
    >
      <ul className="row-list">
        {(query.data ?? []).map((user) => (
          <li className="row-item" key={user.id}>
            <div className="row-main">
              <div className="row-title">{user.fullName}</div>
              <div className="small muted">
                {user.roles.join(', ')} · KYC {user.kycTier.replace('_', ' ')}
              </div>
            </div>
            <StatusBadge tone={user.isVerified ? 'success' : 'warning'}>
              {user.isVerified ? 'verified' : 'unverified'}
            </StatusBadge>
          </li>
        ))}
      </ul>
    </QueryState>
  );
}
