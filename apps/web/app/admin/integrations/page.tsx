import type { Metadata } from 'next';
import { ChannelStatusCards } from '@/components/channel-status';
import {
  ExternalLinksTable,
  FarmRecordsPanel,
  ImportBatchesPanel
} from '@/components/federation-admin';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Admin Integrations',
  description:
    'Channel driver status, federated account links, farm-record sync and beneficiary import confirm-before-merge for platform administrators.'
};

export default function AdminIntegrationsPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Admin console"
        title="Integrations and federation"
        description="Notification channel drivers, farm-data federation links and consent-gated beneficiary imports."
      />

      <Section
        kicker="Channels"
        title="Notification drivers"
        description="Configured vs stub drivers for each member-facing channel."
      >
        <ChannelStatusCards />
      </Section>

      <Section
        kicker="Federation"
        title="External account links"
        description="farmOS and LiteFarm links are consent-gated; revoking is a soft delete."
      >
        <ExternalLinksTable />
      </Section>

      <Section kicker="Farm data" title="Farm records">
        <FarmRecordsPanel />
      </Section>

      <Section
        kicker="Imports"
        title="Beneficiary import"
        description="Staged batches merge only after an explicit confirm; rejected rows keep their reason."
      >
        <ImportBatchesPanel />
      </Section>
    </div>
  );
}
