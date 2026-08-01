import type { Metadata } from 'next';
import { MentorBoard, TopicsSection } from '@/components/community-live';
import { Card, PageHeader, Section, StatusBadge } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Community',
  description: 'Forums, state and crop groups, and mentorship matching — bridged with Discourse.'
};

export default function CommunityPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Community"
        title="Learn from farmers like you"
        description="Forum topics are syndicated from the Discourse bridge and cached for offline reading."
      />

      <Section kicker="Forums" title="Trending topics">
        <TopicsSection />
      </Section>

      <Section
        kicker="Mentorship"
        title="Mentor matching"
        description="Experienced farmers and agribusiness mentors are matched by crop, state and challenge."
      >
        <MentorBoard />
      </Section>

      <Section kicker="Groups" title="Find your people">
        <div className="grid grid-4">
          {['Kaduna maize growers', 'Women in poultry', 'NYSC agribusiness clubs', 'Cassava processors'].map(
            (group, index) => (
              <Card key={group} title={group}>
                <p className="small muted">
                  {['State group', 'Programme group', 'Student group', 'Value chain group'][index]} · moderated
                </p>
                <StatusBadge tone="success">open</StatusBadge>
              </Card>
            )
          )}
        </div>
      </Section>
    </div>
  );
}
