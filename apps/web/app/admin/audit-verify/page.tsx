import type { Metadata } from 'next';
import { AuditVerifyPanel } from '@/components/platform-admin-live';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Audit chain check',
  description:
    'Verify the tamper-evident audit hash chain over the full log or a contiguous event range.'
};

export default function AdminAuditVerifyPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Admin console"
        title="Audit chain check"
        description="Re-walk the audit hash chain to prove the log has not been altered. Regulators can verify a contiguous range between two event ids."
      />
      <Section
        kicker="Integrity"
        title="Verify"
        description="The check reports the first broken link, if any."
      >
        <AuditVerifyPanel />
      </Section>
    </div>
  );
}
