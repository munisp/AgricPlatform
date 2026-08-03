'use client';

import { useAppState } from '@/lib/app-state';
import { useApiQuery } from '@/lib/api/hooks';
import { partnerImpact, partnerProgrammes } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/errors';
import { partnerProgrammes as fixtureProgrammes } from '@/lib/content';
import { AutoBadge, Card, ProgressBar } from '@/components/ui';
import { OfflineDataNotice, QueryState } from '@/components/api-state';

/**
 * 401/403 means the caller simply has no partner scope — that is an honest
 * "access required" state, NOT a connectivity problem, so fixture stats must
 * not stand in for it (G20).
 */
function isAuthorizationError(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.statusCode === 401 || error.statusCode === 403)
  );
}

/** Honest empty state for callers without partner scope (no fixture data). */
function PartnerAccessRequired() {
  return (
    <div className="notice notice-info" role="status">
      <strong>Partner access required.</strong> Programme impact and participant stats are
      only visible to enrolled partner organisations. Contact your programme officer to
      enrol.
    </div>
  );
}

export function PartnerProgrammes() {
  const { userId, hydrated } = useAppState();
  const query = useApiQuery(
    hydrated ? `partner:programmes:${userId}` : null,
    () => partnerProgrammes(userId).then((res) => res.data),
    { enabled: hydrated }
  );

  if (query.error) {
    if (isAuthorizationError(query.error)) {
      return <PartnerAccessRequired />;
    }
    // Genuine network/server failure: fall back to the static programme
    // blurbs (clearly marked) so the hub layout stays useful.
    return (
      <>
        <OfflineDataNotice>
          Live partner programmes unavailable — showing programme catalogue copy.
        </OfflineDataNotice>
        <div className="grid grid-3">
          {fixtureProgrammes.map((programme) => (
            <Card key={programme.id} title={programme.name}>
              <p className="small muted">{programme.scope}</p>
              <p className="small">
                <strong>{programme.participants}</strong> participants
              </p>
              <ProgressBar value={programme.completionRate} label="Completion rate" />
              <div style={{ marginTop: '0.75rem' }}>
                <AutoBadge value={programme.status} />
              </div>
            </Card>
          ))}
        </div>
      </>
    );
  }

  return (
    <QueryState
      isLoading={query.isLoading}
      error={undefined}
      data={query.data}
      onRetry={query.refresh}
      empty={
        <p className="small muted">
          No programmes in your scope yet — published opportunities appear here.
        </p>
      }
    >
      <div className="grid grid-3">
        {(query.data ?? []).map((programme) => (
          <Card key={programme.id} title={programme.title}>
            <p className="small muted">{programme.description}</p>
            <p className="small">
              {programme.states.length > 6 ? 'Nationwide' : programme.states.join(', ')}
            </p>
            <div style={{ marginTop: '0.75rem' }}>
              <AutoBadge value={programme.isActive ? 'active' : 'draft'} />
            </div>
          </Card>
        ))}
      </div>
    </QueryState>
  );
}

export function PartnerImpactCard() {
  const { userId, hydrated } = useAppState();
  const query = useApiQuery(
    hydrated ? `partner:impact:${userId}` : null,
    () => partnerImpact(userId).then((res) => res.data),
    { enabled: hydrated }
  );

  if (query.error) {
    if (isAuthorizationError(query.error)) {
      return <PartnerAccessRequired />;
    }
    return (
      <OfflineDataNotice>
        Impact report unavailable — the API is unreachable or temporarily down.
      </OfflineDataNotice>
    );
  }

  return (
    <QueryState
      isLoading={query.isLoading}
      error={undefined}
      data={query.data}
      onRetry={query.refresh}
    >
      {query.data ? (
        <div className="grid grid-3">
          <div className="metric-card">
            <div className="metric-value">{query.data.programmes}</div>
            <div className="metric-label">Programmes</div>
          </div>
          <div className="metric-card">
            <div className="metric-value">{query.data.participants}</div>
            <div className="metric-label">Participants</div>
          </div>
          <div className="metric-card">
            <div className="metric-value">{query.data.completedTrainings}</div>
            <div className="metric-label">Completed trainings</div>
          </div>
        </div>
      ) : null}
    </QueryState>
  );
}
