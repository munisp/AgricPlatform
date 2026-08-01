'use client';

import { useApiQuery } from '@/lib/api/hooks';
import { listIntegrations } from '@/lib/api/endpoints';
import { integrations as fixtureIntegrations } from '@/lib/content';
import { IntegrationCard, StatusBadge } from '@/components/ui';
import { OfflineDataNotice, QueryState } from '@/components/api-state';

export function IntegrationsStatus() {
  // Admin-gated at the API (GET /integrations requires the admin role); the
  // static catalogue copy is the fallback for other roles and offline use.
  const query = useApiQuery(
    'integrations:status',
    () => listIntegrations().then((res) => res.data),
    { fallbackData: fixtureIntegrations, staleTimeMs: 60_000 }
  );
  const integrations = query.data ?? fixtureIntegrations;

  const stubCount = integrations.filter((i) => i.driver === 'stub').length;
  const sandboxCount = integrations.filter((i) => i.driver === 'sandbox').length;
  const unconfigured = integrations.filter((i) => !i.configured).length;

  return (
    <>
      {query.source === 'fallback' ? (
        <OfflineDataNotice>
          Live integration status is admin-only — showing the provider catalogue.
        </OfflineDataNotice>
      ) : null}
      <section className="section-tight">
        <div className="cluster">
          <StatusBadge tone="neutral">{stubCount} stub drivers</StatusBadge>
          <StatusBadge tone="info">{sandboxCount} sandbox drivers</StatusBadge>
          <StatusBadge tone="warning">{unconfigured} awaiting credentials</StatusBadge>
        </div>
      </section>
      <QueryState
        isLoading={query.isLoading}
        error={undefined}
        data={integrations}
        onRetry={query.refresh}
      >
        <div className="grid grid-3">
          {integrations.map((integration) => (
            <IntegrationCard key={integration.provider} integration={integration} />
          ))}
        </div>
      </QueryState>
    </>
  );
}
