'use client';

import Link from 'next/link';
import { useAppState } from '@/lib/app-state';
import { useSession } from '@/lib/session';
import { useApiQuery } from '@/lib/api/hooks';
import { fetchDashboard } from '@/lib/api/endpoints';
import type { DashboardWidget } from '@/lib/api/endpoints';
import { usePersistentState } from '@/lib/use-persistent-state';
import { MODULES, ROLE_LABELS, ROLE_SUMMARIES } from '@/lib/content';
import { calculateProfileCompletion, profileBadge } from '@agric-platform/shared';
import { ModuleCard, ProgressBar, StatusBadge } from '@/components/ui';
import { OfflineDataNotice } from '@/components/api-state';

interface OnboardingDraft {
  fullName?: string;
  state?: string;
  lga?: string;
  farmingInterests?: string[];
  valueChains?: string[];
  bio?: string;
  farmSizeHectares?: string;
  yearsExperience?: string;
}

function widgetListLabel(item: unknown): string {
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    for (const key of ['title', 'courseId', 'opportunityId', 'id', 'status']) {
      if (typeof record[key] === 'string') return String(record[key]);
    }
    if (typeof record.progressPercent === 'number') return `Progress ${record.progressPercent}%`;
  }
  return String(item);
}

function DashboardWidgetCard({ widget }: { widget: DashboardWidget }) {
  if (widget.kind === 'metric' && widget.data && typeof widget.data === 'object') {
    const data = widget.data as Record<string, unknown>;
    const value = data.score ?? data.count ?? '—';
    return (
      <div className="card">
        <h3>{widget.title}</h3>
        <div className="metric-value">{String(value)}</div>
        {Array.isArray(data.badges) && data.badges.length > 0 ? (
          <div className="cluster" style={{ marginTop: '0.5rem' }}>
            {data.badges.map((badge) => (
              <StatusBadge key={String(badge)} tone="success">
                {String(badge)}
              </StatusBadge>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (widget.kind === 'list' && Array.isArray(widget.data)) {
    return (
      <div className="card">
        <h3>{widget.title}</h3>
        {widget.data.length === 0 ? (
          <p className="small muted">Nothing here yet.</p>
        ) : (
          <ul className="row-list">
            {widget.data.slice(0, 5).map((item, index) => (
              <li className="row-item" key={index}>
                <div className="row-main">
                  <div className="row-title">{widgetListLabel(item)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return null;
}

export function RoleDashboard() {
  const { role, hydrated, userId } = useAppState();
  const { displayName } = useSession();
  const [profile] = usePersistentState<OnboardingDraft>('agric.onboarding-draft', {});

  const dashboardQuery = useApiQuery(
    hydrated ? `dashboard:${userId}` : null,
    () => fetchDashboard(userId).then((res) => res.data),
    { enabled: hydrated }
  );

  const score = calculateProfileCompletion({
    location: profile.state ? { state: profile.state, lga: profile.lga ?? '' } : undefined,
    farmingInterests: profile.farmingInterests ?? [],
    valueChains: profile.valueChains ?? [],
    bio: profile.bio ?? '',
    farmSizeHectares: profile.farmSizeHectares ? Number(profile.farmSizeHectares) : undefined,
    yearsExperience: profile.yearsExperience ? Number(profile.yearsExperience) : undefined
  });

  const modules = MODULES.filter((mod) => mod.roles.includes(role));
  const firstName = displayName?.trim().split(' ')[0] || profile.fullName?.trim().split(' ')[0];
  const liveWidgets = dashboardQuery.source === 'api' ? (dashboardQuery.data?.widgets ?? []) : [];

  return (
    <div className="stack-lg">
      {dashboardQuery.error && dashboardQuery.source !== 'api' ? (
        <OfflineDataNotice>
          Dashboard is offline — showing your locally stored profile and modules.
        </OfflineDataNotice>
      ) : null}
      <div className="card">
        <div className="cluster" style={{ justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ marginBottom: '0.2rem' }}>
              {hydrated && firstName ? `Sannu, ${firstName}` : 'Welcome back'} ·{' '}
              {ROLE_LABELS[role]}
            </h3>
            <p className="small muted" style={{ margin: 0 }}>
              {ROLE_SUMMARIES[role]}
            </p>
          </div>
          <StatusBadge tone={score >= 60 ? 'success' : 'warning'}>{profileBadge(score)} profile</StatusBadge>
        </div>
        <div style={{ marginTop: '1rem' }}>
          <ProgressBar value={score} label="Profile completion" />
        </div>
        {score < 100 ? (
          <p className="small" style={{ marginTop: '0.75rem' }}>
            <Link href="/onboarding">Complete your profile</Link> to unlock more matches and lender
            readiness.
          </p>
        ) : null}
      </div>

      {liveWidgets.length > 0 ? (
        <section aria-label="Live dashboard widgets">
          <h3>Your activity</h3>
          <div className="grid grid-3">
            {liveWidgets.map((widget) => (
              <DashboardWidgetCard key={widget.key} widget={widget} />
            ))}
          </div>
        </section>
      ) : null}

      <section aria-label="Role modules">
        <h3>Your modules</h3>
        <div className="grid grid-3">
          {modules.map((mod) => (
            <ModuleCard
              key={mod.href}
              href={mod.href}
              title={mod.title}
              description={mod.description}
              tag={mod.tag}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
