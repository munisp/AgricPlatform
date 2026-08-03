import type { Metadata } from 'next';
import {
  AnalyticsSummaryCards,
  DailyMetricsTable,
  LakehouseExportPanel,
  ProjectionPanel
} from '@/components/admin-analytics-live';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Analytics marts',
  description:
    'Star-schema analytics marts projected from the domain event outbox: daily GMV, orders, escrow exposure and livestock registration for admins and regulators.'
};

export default function AdminAnalyticsPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Admin console"
        title="Analytics marts"
        description="The platform's real analytical store: star-schema marts in PostgreSQL, projected from the domain event outbox. The lakehouse export ships them to S3-compatible object storage as parquet + a manifest when enabled — no managed lakehouse (Iceberg catalog, managed Trino) exists."
      />

      <Section
        kicker="Overview"
        title="Headline metrics"
        description="GMV, orders, current escrow exposure, livestock registered and the dimension sizes, straight from the marts."
      >
        <AnalyticsSummaryCards />
      </Section>

      <Section
        kicker="Rollups"
        title="Daily metrics"
        description="Africa/Lagos calendar-day rollups recomputed from the fact tables on every projection run."
      >
        <DailyMetricsTable />
      </Section>

      <Section
        kicker="Pipeline"
        title="Projection and lakehouse handoff"
        description="Run a projection pass (normally driven by an external scheduler), download the parquet-ready fact CSVs, or export the marts to object storage."
      >
        <ProjectionPanel />
        <div style={{ marginTop: '1rem' }}>
          <LakehouseExportPanel />
        </div>
      </Section>
    </div>
  );
}
