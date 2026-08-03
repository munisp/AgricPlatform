import type { Metadata } from 'next';
import { AdminAuditList, AdminKpis, AdminReviewQueueTable, AdminUserList } from '@/components/admin-live';
import { AnalyticsExportButtons } from '@/components/analytics-export';
import { Card, ModuleCard, PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Admin Console',
  description: 'User operations, review queues, platform KPIs and audit trail for platform administrators.'
};

export default function AdminPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Admin console"
        title="Operate the platform"
        description="Administrative surfaces are role-gated at the API; this reference view shows the operator experience."
      />

      <Section kicker="KPIs" title="Platform health">
        <AdminKpis />
      </Section>

      <Section kicker="Depth" title="Admin surfaces">
        <div className="grid grid-2">
          <ModuleCard
            href="/admin/insights"
            title="Insights & data marts"
            description="Segmentation, funnels, weekly retention and KPI mart snapshot/export controls."
            tag="Analytics depth"
          />
          <ModuleCard
            href="/admin/integrations"
            title="Integrations & federation"
            description="Channel drivers, external account links, farm-record sync and beneficiary imports."
            tag="Federation"
          />
          {/* Wave GEO (additive): geospatial cluster map. */}
          <ModuleCard
            href="/admin/geo"
            title="Farm cluster map"
            description="H3-indexed farm plots clustered per grid cell, with index rebuild controls."
            tag="Geospatial"
          />
        </div>
      </Section>

      <Section kicker="People" title="Users">
        <AdminUserList />
      </Section>

      <Section kicker="Operations" title="Review queue">
        <AdminReviewQueueTable />
      </Section>

      <Section
        kicker="Reporting"
        title="Analytics export"
        description="Downloads the full metrics bundle as CSV or PDF. Every export is audit-logged on the API."
      >
        <AnalyticsExportButtons />
      </Section>

      <Section kicker="Audit" title="Recent audit events" description="Immutable audit log for admin and sensitive operations.">
        <AdminAuditList />
      </Section>

      <Section kicker="Domains" title="Module operations">
        <div className="grid grid-3">
          {[
            'Users & verification',
            'Programme management',
            'Marketplace moderation',
            'Notification orchestration',
            'Privacy requests',
            'Integration health'
          ].map((area) => (
            <Card key={area} title={area}>
              <p className="small muted">
                Scoped by RBAC; every mutation requires an idempotency key and writes an audit event.
              </p>
            </Card>
          ))}
        </div>
      </Section>
    </div>
  );
}
