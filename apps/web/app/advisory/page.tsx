import type { Metadata } from 'next';
import { AdvisoryFeed } from '@/components/advisory-live';
import { FloodRiskCard } from '@/components/flood-risk-card';
import { Card, PageHeader, Section, StatusBadge, Timeline } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Advisory',
  description: 'Crop calendar, pest alerts, weather snapshots and price signals for your state and value chains.'
};

const CROP_CALENDAR = [
  { id: 'cc1', title: 'Land preparation', date: 'March – April', description: 'Clear, plough and test soil before rains establish.' },
  { id: 'cc2', title: 'Planting window', date: 'May – June', description: 'Align planting with forecast rainfall onset for your zone.' },
  { id: 'cc3', title: 'Weeding and top-dress', date: 'June – August', description: 'Two weeding passes; apply fertiliser after first weeding.', tone: 'warning' as const },
  { id: 'cc4', title: 'Harvest and storage', date: 'September – November', description: 'Dry to safe moisture before bagging; use hermetic storage.' }
];

export default function AdvisoryPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Advisory & decision support"
        title="Know what to do this week"
        description="Localised crop calendars, pest alerts, weather and price signals — cached for the field."
      />

      <Section kicker="Alerts" title="Latest advisories">
        <AdvisoryFeed />
      </Section>

      <Section kicker="Flood risk" title="Flood risk for your plots">
        <FloodRiskCard />
      </Section>

      <Section kicker="Crop calendar" title="Rainfed maize — Northern Guinea Savanna">
        <Card>
          <Timeline items={CROP_CALENDAR} />
        </Card>
      </Section>

      <Section kicker="Feeds" title="Weather and price readiness">
        <div className="grid grid-2">
          <Card title="Weather snapshot (stub driver)">
            <p className="small muted">
              NiMet/OpenMeteo adapter serves cached 7-day outlooks for your LGA. Live feed activates with
              provider credentials at staging.
            </p>
            <StatusBadge tone="info">stub driver</StatusBadge>
          </Card>
          <Card title="Price signals (stub driver)">
            <p className="small muted">
              FEWS NET and market surveys power price trend cards per crop and state. Compare transport
              cost before accepting offers.
            </p>
            <StatusBadge tone="info">stub driver</StatusBadge>
          </Card>
        </div>
      </Section>
    </div>
  );
}
