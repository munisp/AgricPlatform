import type { Metadata } from 'next';
import {
  CreditApplySection,
  CreditGroupsSection,
  CreditProductsSection,
  CreditSavingsSection,
  CreditScorePreviewSection,
  MyCreditLoansSection
} from '@/components/credit-live';
import { PageHeader, Section } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Credit & Savings',
  description:
    'Loan products, applications, VSLA group lending and savings — with deterministic credit scoring.'
};

export default function CreditPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="credit.kicker" />}
        title={<T k="credit.title" />}
        description={<T k="credit.description" />}
      />

      <Section kicker={<T k="credit.scoreKicker" />} title={<T k="credit.scoreSectionTitle" />}>
        <CreditScorePreviewSection />
      </Section>

      <Section kicker={<T k="credit.productsKicker" />} title={<T k="credit.productsTitle" />}>
        <CreditProductsSection />
      </Section>

      <Section
        kicker={<T k="credit.applyKicker" />}
        title={<T k="credit.applyTitle" />}
        description={<T k="credit.applyDescription" />}
      >
        <CreditApplySection />
      </Section>

      <Section kicker={<T k="credit.loansKicker" />} title={<T k="credit.loansTitle" />}>
        <MyCreditLoansSection />
      </Section>

      <Section
        kicker={<T k="credit.groupsKicker" />}
        title={<T k="credit.groupsTitle" />}
        description={<T k="credit.groupsDescription" />}
      >
        <CreditGroupsSection />
      </Section>

      <Section kicker={<T k="credit.savingsKicker" />} title={<T k="credit.savingsTitle" />}>
        <CreditSavingsSection />
      </Section>
    </div>
  );
}
