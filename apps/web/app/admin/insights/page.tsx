import type { Metadata } from 'next';
import {
  FunnelVisualisation,
  MartControls,
  RetentionHeatmap,
  SegmentationViewer
} from '@/components/admin-insights';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Admin Insights',
  description:
    'Member segmentation, registration and chapter funnels, weekly retention and KPI data marts for platform administrators.'
};

export default function AdminInsightsPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Admin console"
        title="Insights and data marts"
        description="Depth analytics behind the admin role: who the members are, how they convert, whether they stay, and the KPI marts handed off to the lakehouse."
      />

      <Section
        kicker="Segments"
        title="Who are the members"
        description="Counts and percentages of the member population by state, crop, role, KYC tier or signup cohort."
      >
        <SegmentationViewer />
      </Section>

      <Section
        kicker="Conversion"
        title="Funnels"
        description="Registration to first application over a trailing window, and chapter events to attendance."
      >
        <FunnelVisualisation />
      </Section>

      <Section
        kicker="Cohorts"
        title="Retention"
        description="Weekly signup cohorts against later activity; the current week is partial."
      >
        <RetentionHeatmap />
      </Section>

      <Section
        kicker="Lakehouse"
        title="Data marts"
        description="Snapshot jobs and CSV handoff for the member-KPI, marketplace and learning marts."
      >
        <MartControls />
      </Section>
    </div>
  );
}
