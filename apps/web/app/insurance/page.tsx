import type { Metadata } from 'next';
import {
  InsuranceCatalogSection,
  InsuranceQuoteSection,
  InsuranceTriggerMonitorSection,
  InsurancePayoutLedgerSection,
  MyInsurancePoliciesSection
} from '@/components/insurance-live';
import { PageHeader, Section } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Parametric Insurance',
  description:
    'Weather-indexed parametric cover — deterministic triggers, graduated payouts, honest stub/live labels.'
};

export default function InsurancePage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="insurance.kicker" />}
        title={<T k="insurance.title" />}
        description={<T k="insurance.description" />}
      />

      <Section kicker={<T k="insurance.catalogKicker" />} title={<T k="insurance.catalogTitle" />}>
        <InsuranceCatalogSection />
      </Section>

      <Section
        kicker={<T k="insurance.quoteKicker" />}
        title={<T k="insurance.quoteTitle" />}
        description={<T k="insurance.quoteDescription" />}
      >
        <InsuranceQuoteSection />
      </Section>

      <Section kicker={<T k="insurance.policiesKicker" />} title={<T k="insurance.policiesTitle" />}>
        <MyInsurancePoliciesSection />
      </Section>

      <Section kicker={<T k="insurance.monitorKicker" />} title={<T k="insurance.monitorTitle" />}>
        <InsuranceTriggerMonitorSection />
      </Section>

      <Section kicker={<T k="insurance.payoutKicker" />} title={<T k="insurance.payoutTitle" />}>
        <InsurancePayoutLedgerSection />
      </Section>
    </div>
  );
}
