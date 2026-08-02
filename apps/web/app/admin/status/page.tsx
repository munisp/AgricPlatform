import type { Metadata } from 'next';
import { ModuleStatusMatrix } from '@/components/platform-admin-live';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Module status',
  description:
    'Per-module readiness matrix: database, cache, outbox backlog, notification queue, integrations and feature flags.'
};

export default function AdminStatusPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Admin console"
        title="Module status"
        description="Readiness of each platform module: connectivity pings and backlog counters only, refreshed on demand."
      />
      <Section
        kicker="Readiness"
        title="Platform modules"
        description="A degraded module means operators should act; details show the probe counters."
      >
        <ModuleStatusMatrix />
      </Section>
    </div>
  );
}
