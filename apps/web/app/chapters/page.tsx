import type { Metadata } from 'next';
import { seedChapters } from '@agric-platform/shared';
import { AttendanceRecorder } from '@/components/attendance-recorder';
import { Card, PageHeader, Section, StatusBadge } from '@/components/ui';
import { demoEvents } from '@/lib/content';

export const metadata: Metadata = {
  title: 'Chapters',
  description: 'National-to-ward chapter hierarchy, events, RSVP and offline attendance capture.'
};

const ANNOUNCEMENTS = [
  {
    id: 'ann-1',
    chapter: 'Kaduna State Chapter',
    title: 'AGM moved to 24 August',
    body: 'The annual general meeting now follows the maize field day by two weeks to allow harvest reporting.'
  },
  {
    id: 'ann-2',
    chapter: 'NYFN National',
    title: 'New ward chapters onboarding',
    body: 'Twelve ward chapters across Kano and Sokoto begin verification this month.'
  }
];

export default function ChaptersPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Chapter operations"
        title="From national to ward level"
        description="Chapter leads manage rosters, events and attendance — all capturable offline at the field edge."
      />

      <Section kicker="Hierarchy" title="Chapter network">
        <ul className="row-list">
          {seedChapters.map((chapter) => (
            <li className="row-item" key={chapter.id}>
              <div className="row-main">
                <div className="row-title">{chapter.name}</div>
                <div className="small muted">
                  {chapter.level} · {chapter.state}
                  {chapter.parentId ? ' · reports to national' : ''}
                </div>
              </div>
              <span className="small" style={{ fontWeight: 700 }}>
                {chapter.memberCount.toLocaleString('en-NG')} members
              </span>
              <StatusBadge tone={chapter.active ? 'success' : 'neutral'}>
                {chapter.active ? 'active' : 'inactive'}
              </StatusBadge>
            </li>
          ))}
        </ul>
      </Section>

      <Section kicker="Events" title="Upcoming events and RSVP">
        <div className="grid grid-3">
          {demoEvents.map((event) => (
            <Card key={event.id} title={event.title}>
              <p className="small muted">
                {event.type.replace(/_/g, ' ')} · {event.location}
              </p>
              <p className="small">
                {new Date(event.startsAt).toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'short' })}
              </p>
              <StatusBadge tone="info">{event.rsvpCount} RSVPs</StatusBadge>
            </Card>
          ))}
        </div>
      </Section>

      <Section
        kicker="Field capture"
        title="Record attendance"
        description="Works fully offline at the venue; records queue as chapter.event.attendance_recorded events."
      >
        <AttendanceRecorder />
      </Section>

      <Section kicker="Announcements" title="Chapter announcements">
        <div className="grid grid-2">
          {ANNOUNCEMENTS.map((announcement) => (
            <Card key={announcement.id} title={announcement.title}>
              <p className="small muted">{announcement.body}</p>
              <span className="small" style={{ fontWeight: 600 }}>
                {announcement.chapter}
              </span>
            </Card>
          ))}
        </div>
      </Section>
    </div>
  );
}
