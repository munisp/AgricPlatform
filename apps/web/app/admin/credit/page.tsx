import type { Metadata } from 'next';
import {
  CreditGroupLoansSection,
  CreditPortfolioSection,
  CreditReviewQueueSection
} from '@/components/admin-credit-live';
import { PageHeader, Section } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Credit Operations',
  description:
    'Loan review queue with score breakdowns, portfolio-at-risk ratios and VSLA group lending.'
};

export default function AdminCreditPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="credit.adminKicker" />}
        title={<T k="credit.adminTitle" />}
        description={<T k="credit.adminDescription" />}
      />

      <Section kicker={<T k="credit.portfolioKicker" />} title={<T k="credit.portfolioTitle" />}>
        <CreditPortfolioSection />
      </Section>

      <Section
        kicker={<T k="credit.queueKicker" />}
        title={<T k="credit.queueTitle" />}
        description={<T k="credit.queueDescription" />}
      >
        <CreditReviewQueueSection />
      </Section>

      <Section kicker={<T k="credit.groupLoansKicker" />} title={<T k="credit.groupLoansTitle" />}>
        <CreditGroupLoansSection />
      </Section>
    </div>
  );
}
