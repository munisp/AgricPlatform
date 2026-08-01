import type { Metadata } from 'next';
import { platformMetrics } from '@agric-platform/shared';
import { AutoBadge, Card, MetricsGrid, PageHeader, Section, StatusBadge } from '@/components/ui';
import { demoAuditEvents, reviewQueue } from '@/lib/content';

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
        <MetricsGrid metrics={platformMetrics} />
      </Section>

      <Section kicker="Operations" title="Review queue">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Type</th>
                <th>Submitted</th>
                <th>Priority</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {reviewQueue.map((item) => (
                <tr key={item.id}>
                  <td>{item.subject}</td>
                  <td>{item.kind}</td>
                  <td>{new Date(item.submitted).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</td>
                  <td>
                    <StatusBadge
                      tone={item.priority === 'high' ? 'critical' : item.priority === 'medium' ? 'warning' : 'neutral'}
                    >
                      {item.priority}
                    </StatusBadge>
                  </td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-small" disabled title="Enabled when the API is connected">
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section kicker="Audit" title="Recent audit events" description="Immutable audit log for admin and sensitive operations.">
        <ul className="row-list">
          {demoAuditEvents.map((event) => (
            <li className="row-item" key={event.id}>
              <div className="row-main">
                <div className="row-title">{event.action}</div>
                <div className="small muted">
                  {event.entityType} #{event.entityId} · actor {event.actorId} ·{' '}
                  {new Date(event.createdAt).toLocaleString('en-NG')}
                </div>
              </div>
              <AutoBadge value="recorded" />
            </li>
          ))}
        </ul>
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
