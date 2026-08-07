import type { Metadata } from 'next';
import { MrvReportSection, VslaCarbonDashboard } from '@/components/vsla-carbon-live';
import { PageHeader, Section } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'VSLA & Carbon MRV',
  description:
    'Village savings & loan groups with ledger-backed cycles and share-outs, plus carbon MRV estimates — always labelled estimate, never verification-grade.'
};

export default function VslaCarbonPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="vslaCarbon.kicker" />}
        title={<T k="vslaCarbon.title" />}
        description={<T k="vslaCarbon.description" />}
      />

      <Section
        kicker={<T k="vslaCarbon.groupsKicker" />}
        title={<T k="vslaCarbon.groupsTitle" />}
        description={<T k="vslaCarbon.groupsDescription" />}
      >
        <VslaCarbonDashboard />
      </Section>

      <Section
        kicker={<T k="vslaCarbon.reportKicker" />}
        title={<T k="vslaCarbon.reportTitle" />}
        description={<T k="vslaCarbon.reportDescription" />}
      >
        <MrvReportSection groupId={null} />
      </Section>
    </div>
  );
}
