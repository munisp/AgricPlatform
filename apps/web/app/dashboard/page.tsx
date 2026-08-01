import type { Metadata } from 'next';
import { RoleDashboard } from '@/components/dashboard-client';
import { LiveMetrics, LiveNotifications } from '@/components/dashboard-live';
import { QueueList } from '@/components/queue-list';
import { NotificationPreferences } from '@/components/notification-preferences';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Role-aware dashboard with profile progress, quick actions, offline queue and notification preferences.'
};

export default function DashboardPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Dashboard"
        title="Your farm operating system"
        description="Switch roles in the header to preview how AgricPlatform adapts to each stakeholder."
      />
      <section className="section-tight">
        <RoleDashboard />
      </section>

      <Section kicker="Indicators" title="Platform metrics">
        <LiveMetrics />
      </Section>

      <Section kicker="Offline first" title="Sync queue">
        <QueueList />
      </Section>

      <Section kicker="Activity" title="Recent notifications">
        <LiveNotifications />
      </Section>

      <Section kicker="Communication" title="Notification preferences" id="notifications">
        <NotificationPreferences />
      </Section>
    </div>
  );
}
