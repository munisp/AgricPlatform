import type { Metadata } from 'next';
import { KYC_TIERS } from '@agric-platform/shared';
import { AutoBadge, Card, PageHeader, ProgressBar, Section, StatusBadge } from '@/components/ui';
import { demoCreditProfile, demoDocuments } from '@/lib/content';

export const metadata: Metadata = {
  title: 'Finance & Credit',
  description: 'Credit readiness scoring, KYC tiers, document vault and lender matching foundations.'
};

const SIGNALS = [
  { label: 'Training signals', value: demoCreditProfile.trainingSignals, max: 30 },
  { label: 'Transaction signals', value: demoCreditProfile.transactionSignals, max: 30 },
  { label: 'Production signals', value: demoCreditProfile.productionSignals, max: 40 }
];

const KYC_LABELS: Record<(typeof KYC_TIERS)[number], string> = {
  tier_0: 'Tier 0 — phone verified',
  tier_1: 'Tier 1 — ID verified',
  tier_2: 'Tier 2 — documents verified',
  tier_3: 'Tier 3 — full KYC (BVN/NIN)'
};

export default function FinancePage() {
  const verifiedDocs = demoDocuments.filter((doc) => doc.status === 'verified').length;

  return (
    <div className="container">
      <PageHeader
        kicker="Finance & credit readiness"
        title="Build a record lenders can trust"
        description="Training, transactions and production history combine into a credit-ready profile — no collateral paperwork lost to connectivity."
      />

      <Section kicker="Credit profile" title="Your readiness score">
        <div className="grid grid-2">
          <Card title={`Score: ${demoCreditProfile.score} / 100`}>
            <ProgressBar value={demoCreditProfile.score} label="Credit readiness" />
            <div className="stack" style={{ marginTop: '1rem' }}>
              {SIGNALS.map((signal) => (
                <ProgressBar
                  key={signal.label}
                  value={(signal.value / signal.max) * 100}
                  label={`${signal.label} (${signal.value}/${signal.max})`}
                />
              ))}
            </div>
          </Card>
          <Card title="Next best actions">
            <ul className="row-list">
              {demoCreditProfile.improvementActions.map((action) => (
                <li className="row-item" key={action}>
                  <div className="row-main small">{action}</div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
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

      <Section
        kicker="Document vault"
        title={`Vault documents (${demoDocuments.length})`}
        description={`${verifiedDocs} verified · stored encrypted; filenames only in this reference build.`}
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Kind</th>
                <th>Uploaded</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {demoDocuments.map((doc) => (
                <tr key={doc.id}>
                  <td>{doc.fileName}</td>
                  <td>{doc.kind.replace(/_/g, ' ')}</td>
                  <td>{new Date(doc.uploadedAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</td>
                  <td>
                    <AutoBadge value={doc.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
