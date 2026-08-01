import type { Metadata } from 'next';
import { IntegrationCard, PageHeader, Section, StatusBadge } from '@/components/ui';
import { integrations } from '@/lib/content';

export const metadata: Metadata = {
  title: 'Integrations',
  description: 'Provider adapters with local stubs, sandbox drivers and production readiness notes.'
};

export default function IntegrationsPage() {
  const stubCount = integrations.filter((i) => i.driver === 'stub').length;
  const sandboxCount = integrations.filter((i) => i.driver === 'sandbox').length;
  const unconfigured = integrations.filter((i) => !i.configured).length;

  return (
    <div className="container">
      <PageHeader
        kicker="Integration readiness"
        title="Providers behind adapters"
        description="Every external system is a port with a local stub, so the platform builds and demos without secrets. Production drivers activate per environment."
      />

      <section className="section-tight">
        <div className="cluster">
          <StatusBadge tone="neutral">{stubCount} stub drivers</StatusBadge>
          <StatusBadge tone="info">{sandboxCount} sandbox drivers</StatusBadge>
          <StatusBadge tone="warning">{unconfigured} awaiting credentials</StatusBadge>
        </div>
      </section>

      <Section kicker="Catalogue" title="Provider status">
        <div className="grid grid-3">
          {integrations.map((integration) => (
            <IntegrationCard key={integration.provider} integration={integration} />
          ))}
        </div>
      </Section>
    </div>
  );
}
