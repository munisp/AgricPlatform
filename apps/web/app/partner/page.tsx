import type { Metadata } from 'next';
import { AutoBadge, Card, PageHeader, ProgressBar, Section } from '@/components/ui';
import { partnerProgrammes } from '@/lib/content';

export const metadata: Metadata = {
  title: 'Partner Hub',
  description: 'Scoped partner programmes, participant progress and impact reporting.'
};

export default function PartnerPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Partner hub"
        title="Programmes with measurable impact"
        description="Partners see only their scoped programmes and aggregated participant data — never unrelated member records."
      />

      <Section kicker="Programmes" title="Your programmes">
        <div className="grid grid-3">
          {partnerProgrammes.map((programme) => (
            <Card key={programme.id} title={programme.name}>
              <p className="small muted">{programme.scope}</p>
              <p className="small">
                <strong>{programme.participants}</strong> participants
              </p>
              <ProgressBar value={programme.completionRate} label="Completion rate" />
              <div style={{ marginTop: '0.75rem' }}>
                <AutoBadge value={programme.status} />
              </div>
            </Card>
          ))}
        </div>
      </Section>

      <Section kicker="Impact" title="Impact reporting">
        <div className="grid grid-2">
          <Card title="Quarterly impact export">
            <p className="small muted">
              Aggregated, consented participant outcomes: completion rates, placements, disbursement
              readiness and adoption of practices. Exports are watermark-audited.
            </p>
            <button type="button" className="btn btn-ghost btn-small" disabled title="Enabled when the API is connected">
              Generate report
            </button>
          </Card>
          <Card title="Post an opportunity">
            <p className="small muted">
              Publish grants, programmes, jobs or equipment schemes to matched members by state and value
              chain. Submissions enter the admin review queue first.
            </p>
            <button type="button" className="btn btn-ghost btn-small" disabled title="Enabled when the API is connected">
              Draft opportunity
            </button>
          </Card>
        </div>
      </Section>

      <Section kicker="Data protection" title="Partner data boundaries">
        <div className="notice notice-info">
          Partner access is scope-limited and audit-logged. Members control programme data sharing through
          the “Partner programme sharing” consent on the privacy page.
        </div>
      </Section>
    </div>
  );
}
