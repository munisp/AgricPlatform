import type { Metadata } from 'next';
import { IntegrationsStatus } from '@/components/integrations-live';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Integrations',
  description: 'Provider adapters with local stubs, sandbox drivers and production readiness notes.'
};

export default function IntegrationsPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Integration readiness"
        title="Providers behind adapters"
        description="Every external system is a port with a local stub, so the platform builds and demos without secrets. Production drivers activate per environment."
      />

      <Section kicker="Catalogue" title="Provider status">
        <IntegrationsStatus />
      </Section>
    </div>
  );
}
