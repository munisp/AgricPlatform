import type { Metadata } from 'next';
import {
  CreditGroupLoansSection,
  CreditPortfolioSection,
  CreditReviewQueueSection
} from '@/components/admin-credit-live';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Credit Operations',
  description:
    'Loan review queue with score breakdowns, portfolio-at-risk ratios and VSLA group lending.'
};

export default function AdminCreditPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Credit operations"
        title="Loan review and portfolio risk"
        description="Score applications, approve or reject, and watch portfolio-at-risk ratios."
      />

      <Section kicker="Portfolio at risk" title="PAR ratios">
        <CreditPortfolioSection />
      </Section>

      <Section
        kicker="Review queue"
        title="Applications needing review"
        description="Deterministic five-factor scores accompany every submitted application."
      >
        <CreditReviewQueueSection />
      </Section>

      <Section kicker="Group lending" title="VSLA group loans">
        <CreditGroupLoansSection />
      </Section>
    </div>
  );
}
