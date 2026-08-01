import type { Metadata } from 'next';
import { platformMetrics } from '@agric-platform/shared';
import { RoleDashboard } from '@/components/dashboard-client';
import { QueueList } from '@/components/queue-list';
import { NotificationPreferences } from '@/components/notification-preferences';
import { AutoBadge, MetricsGrid, PageHeader, Section, Timeline } from '@/components/ui';
import { demoNotifications } from '@/lib/content';

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
        <MetricsGrid metrics={platformMetrics.slice(0, 3)} />
      </Section>

      <Section kicker="Offline first" title="Sync queue">
        <QueueList />
      </Section>

      <Section kicker="Activity" title="Recent notifications">
        <div className="grid grid-2">
          <Timeline
            items={demoNotifications.map((notif) => ({
              id: notif.id,
              title: notif.title,
              date: `${notif.channel.replace('_', ' ')} · ${new Date(notif.createdAt).toLocaleString('en-NG')}`,
              description: notif.body,
              tone: notif.status === 'queued' ? 'warning' : 'default'
            }))}
          />
          <div className="card">
            <h3>Delivery status</h3>
            <ul className="row-list">
              {demoNotifications.map((notif) => (
                <li className="row-item" key={notif.id}>
                  <div className="row-main">
                    <div className="row-title">{notif.title}</div>
                    <div className="small muted">{notif.channel.replace('_', ' ')}</div>
                  </div>
                  <AutoBadge value={notif.status} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section kicker="Communication" title="Notification preferences" id="notifications">
        <NotificationPreferences />
      </Section>
    </div>
  );
}
