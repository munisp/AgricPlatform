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

export const metadata: Metadata = {
  title: 'Credit & Savings',
  description:
    'Loan products, applications, VSLA group lending and savings — with deterministic credit scoring.'
};

export default function CreditPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Credit & savings"
        title="Loans, groups and savings"
        description="Apply for a loan, join a savings group, and track every repayment — online or offline."
      />

      <Section kicker="Credit score" title="Your score preview">
        <CreditScorePreviewSection />
      </Section>

      <Section kicker="Loan products" title="Choose a product">
        <CreditProductsSection />
      </Section>

      <Section
        kicker="Apply"
        title="Loan application"
        description="Drafts submit straight into scoring — the review team sees your factor breakdown."
      >
        <CreditApplySection />
      </Section>

      <Section kicker="My loans" title="Applications and repayments">
        <MyCreditLoansSection />
      </Section>

      <Section
        kicker="Savings groups"
        title="My VSLA groups"
        description="Group members co-guarantee group loans and share a group savings account."
      >
        <CreditGroupsSection />
      </Section>

      <Section kicker="Savings" title="My savings account">
        <CreditSavingsSection />
      </Section>
    </div>
  );
}
