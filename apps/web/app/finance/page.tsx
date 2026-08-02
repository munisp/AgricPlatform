import type { Metadata } from 'next';
import { KYC_TIERS } from '@agric-platform/shared';
import { CreditProfileSection, DocumentVault } from '@/components/finance-live';
import { CreditScoreSection, LenderMatchSection, MyLoansSection } from '@/components/finance-credit';
import { Card, PageHeader, Section, StatusBadge } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Finance & Credit',
  description: 'Credit readiness scoring, KYC tiers, document vault and lender matching foundations.'
};

const KYC_LABELS: Record<(typeof KYC_TIERS)[number], string> = {
  tier_0: 'Tier 0 — phone verified',
  tier_1: 'Tier 1 — ID verified',
  tier_2: 'Tier 2 — documents verified',
  tier_3: 'Tier 3 — full KYC (BVN/NIN)'
};

export default function FinancePage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Finance & credit readiness"
        title="Build a record lenders can trust"
        description="Training, transactions and production history combine into a credit-ready profile — no collateral paperwork lost to connectivity."
      />

      <Section kicker="Credit profile" title="Your readiness score">
        <CreditProfileSection />
      </Section>

      <Section
        kicker="Credit score"
        title="Versioned score breakdown"
        description="Training, trade history, repayments and documentation feed one deterministic score."
      >
        <CreditScoreSection />
      </Section>

      <Section kicker="Lenders" title="Lender matches">
        <LenderMatchSection />
      </Section>

      <Section kicker="Loans" title="My loans and repayments">
        <MyLoansSection />
      </Section>

      <Section kicker="KYC" title="Verification tiers" description="Higher tiers unlock larger lender matches and escrow limits.">
        <div className="grid grid-4">
          {KYC_TIERS.map((tier, index) => (
            <Card key={tier} title={KYC_LABELS[tier]}>
              <StatusBadge tone={index <= 1 ? 'success' : 'neutral'}>
                {index <= 1 ? 'achieved' : 'locked'}
              </StatusBadge>
            </Card>
          ))}
        </div>
      </Section>

      <Section kicker="Document vault" title="Vault documents">
        <DocumentVault />
      </Section>

      <Section kicker="Ledger" title="Phase 1 financial design">
        <div className="notice notice-info">
          Financial state uses a double-entry PostgreSQL ledger in Phase 1, with a TigerBeetle adapter
          reserved for Phase 2 scale. All balance changes are immutable transfers — never edits.
        </div>
      </Section>
    </div>
  );
}
