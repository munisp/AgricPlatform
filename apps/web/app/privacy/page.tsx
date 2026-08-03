import type { Metadata } from 'next';
import { ComplianceCenter } from '@/components/compliance-center';
import { PrivacyCenter } from '@/components/privacy-center';
import { PageHeader, Section, Timeline } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Privacy & NDPR',
  description: 'NDPR/NDPA consent management, data export and deletion requests.'
};

const RIGHTS = [
  { id: 'r1', title: 'Consent first', date: 'NDPR Art. 2.2', description: 'Every processing purpose is opt-in, timestamped and revocable.' },
  { id: 'r2', title: 'Access and export', date: 'NDPA s.37', description: 'Request a machine-readable copy of everything we hold about you.' },
  { id: 'r3', title: 'Erasure', date: 'NDPA s.38', description: 'Delete your account; legally retained records are pseudonymised.', tone: 'clay' as const },
  { id: 'r4', title: 'Auditability', date: 'Internal control', description: 'All admin and partner access to your data appears in the audit log.' }
];

export default function PrivacyPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Privacy & data protection"
        title="Your data, your decisions"
        description="AgricPlatform treats NDPR/NDPA compliance as a product feature, not a policy page."
      />

      <section className="section-tight" style={{ maxWidth: 860 }}>
        <PrivacyCenter />
      </section>

      <Section
        kicker="NDPA 2023 self-service"
        title="Consent preferences and data-subject requests"
        description="Versioned consent, data export (s.37) and erasure requests (s.38) — recorded against your account and processed under the compliance workflow."
      >
        <div style={{ maxWidth: 860 }}>
          <ComplianceCenter />
        </div>
      </Section>

      <Section kicker="Your rights" title="How NDPR/NDPA applies here">
        <Timeline items={RIGHTS} />
      </Section>
    </div>
  );
}
