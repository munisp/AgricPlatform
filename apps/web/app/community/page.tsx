import type { Metadata } from 'next';
import { AutoBadge, Card, PageHeader, Section, StatusBadge } from '@/components/ui';
import { demoMentorRequests, demoTopics } from '@/lib/content';

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
        <ul className="row-list">
          {demoTopics.map((topic) => (
            <li className="row-item" key={topic.id}>
              <div className="row-main">
                <div className="row-title">{topic.title}</div>
                <div className="small muted">
                  {topic.category}
                  {topic.state ? ` · ${topic.state}` : ''}
                  {topic.crop ? ` · ${topic.crop}` : ''} ·{' '}
                  {new Date(topic.createdAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
                </div>
              </div>
              <StatusBadge tone="neutral">{topic.replyCount} replies</StatusBadge>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        kicker="Mentorship"
        title="Mentor matching"
        description="Experienced farmers and agribusiness mentors are matched by crop, state and challenge."
      >
        <div className="grid grid-2">
          {demoMentorRequests.map((request) => (
            <Card key={request.id} title={`${request.crop} — ${request.state}`}>
              <p className="small muted">{request.challenge}</p>
              <AutoBadge value={request.status} />
            </Card>
          ))}
        </div>
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
