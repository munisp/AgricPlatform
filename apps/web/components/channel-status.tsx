'use client';

import { useApiQuery } from '@/lib/api/hooks';
import { listIntegrations } from '@/lib/api/endpoints';
import type { IntegrationStatus } from '@agric-platform/shared';
import { integrations as fixtureIntegrations } from '@/lib/content';
import { OfflineDataNotice, QueryState } from '@/components/api-state';
import { Card, StatusBadge } from '@/components/ui';
import type { Tone } from '@/components/ui';

/**
 * Notification channel driver cards (SMS / WhatsApp / USSD / IVR / Email /
 * Push) mapped onto the GET /integrations status payload. USSD and IVR have
 * no adapter registered yet — they render as "not wired" so ops can see the
 * gap instead of a silent omission.
 */

interface ChannelSpec {
  channel: string;
  providers: string[];
}

const CHANNELS: ChannelSpec[] = [
  { channel: 'SMS', providers: ['termii'] },
  { channel: 'WhatsApp', providers: ['whatsapp'] },
  { channel: 'USSD', providers: ['ussd'] },
  { channel: 'IVR', providers: ['ivr'] },
  { channel: 'Email', providers: ['mailgun'] },
  { channel: 'Push', providers: ['onesignal'] }
];

export interface ChannelStatus {
  channel: string;
  integration: IntegrationStatus | null;
}

export function mapChannels(integrations: IntegrationStatus[]): ChannelStatus[] {
  const byProvider = new Map(integrations.map((entry) => [entry.provider.toLowerCase(), entry]));
  return CHANNELS.map((spec) => {
    const integration =
      spec.providers.map((provider) => byProvider.get(provider)).find(Boolean) ?? null;
    return { channel: spec.channel, integration };
  });
}

function ChannelCard({ status }: { status: ChannelStatus }) {
  const { channel, integration } = status;
  if (!integration) {
    return (
      <Card title={channel}>
        <div className="cluster">
          <StatusBadge tone="neutral" ariaLabel={`${channel}: no driver registered`}>
            not wired
          </StatusBadge>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          No adapter is registered for this channel yet.
        </p>
      </Card>
    );
  }
  const driverTone: Tone =
    integration.driver === 'production' ? 'success' : integration.driver === 'sandbox' ? 'info' : 'neutral';
  return (
    <Card title={channel}>
      <div className="cluster">
        <StatusBadge tone={driverTone} ariaLabel={`${channel} driver: ${integration.driver}`}>
          {integration.driver}
        </StatusBadge>
        <StatusBadge
          tone={integration.configured ? 'success' : 'warning'}
          ariaLabel={`${channel} ${integration.configured ? 'configured' : 'not configured'}`}
        >
          {integration.configured ? 'configured' : 'awaiting credentials'}
        </StatusBadge>
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>
        {integration.provider} · {integration.capability}
      </p>
    </Card>
  );
}

export function ChannelStatusCards() {
  const query = useApiQuery(
    'integrations:status',
    () => listIntegrations().then((res) => res.data),
    { fallbackData: fixtureIntegrations, staleTimeMs: 60_000 }
  );
  const channels = mapChannels(query.data ?? fixtureIntegrations);

  return (
    <>
      {query.source === 'fallback' ? (
        <OfflineDataNotice>
          Live integration status is admin-only — showing the provider catalogue.
        </OfflineDataNotice>
      ) : null}
      <QueryState
        isLoading={query.isLoading}
        error={undefined}
        data={channels}
        onRetry={query.refresh}
      >
        <div className="grid grid-3">
          {channels.map((status) => (
            <ChannelCard key={status.channel} status={status} />
          ))}
        </div>
      </QueryState>
    </>
  );
}
