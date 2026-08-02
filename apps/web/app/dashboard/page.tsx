import type { Metadata } from 'next';
import { RoleDashboard } from '@/components/dashboard-client';
import { LiveMetrics, LiveNotifications } from '@/components/dashboard-live';
import { LivestockSummaryCard } from '@/components/livestock-dashboard-widget';
import { RecommendationsRail } from '@/components/recommendations-rail';
import { QueueList } from '@/components/queue-list';
import { NotificationPreferences } from '@/components/notification-preferences';
import { T } from '@/lib/i18n';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Role-aware dashboard with profile progress, quick actions, offline queue and notification preferences.'
};

export default function DashboardPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="dashboard.kicker" />}
        title={<T k="dashboard.title" />}
        description={<T k="dashboard.description" />}
      />
      <section className="section-tight">
        <RoleDashboard />
      </section>

      {/* Farmer persona only — the card hides itself for other roles. */}
      <section className="section-tight" aria-label="Livestock">
        <LivestockSummaryCard />
      </section>

      <RecommendationsRail />

      <Section kicker={<T k="dashboard.metricsKicker" />} title={<T k="dashboard.metricsTitle" />}>
        <LiveMetrics />
      </Section>

      <Section kicker={<T k="dashboard.queueKicker" />} title={<T k="dashboard.queueTitle" />}>
        <QueueList />
      </Section>

      <Section kicker={<T k="dashboard.activityKicker" />} title={<T k="dashboard.activityTitle" />}>
        <LiveNotifications />
      </Section>

      <Section kicker={<T k="dashboard.prefsKicker" />} title={<T k="dashboard.prefsTitle" />} id="notifications">
        <NotificationPreferences />
      </Section>
    </div>
  );
}
