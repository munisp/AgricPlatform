import type { Metadata } from 'next';
import { AttendanceRecorder } from '@/components/attendance-recorder';
import { ChapterEvents, ChapterNetwork } from '@/components/chapters-live';
import { Card, PageHeader, Section } from '@/components/ui';

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
        <ChapterNetwork />
      </Section>

      <Section kicker="Events" title="Upcoming events and RSVP">
        <ChapterEvents />
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
