import type { Metadata } from 'next';
import { AttendanceCheckIn } from '@/components/attendance-check-in';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Event check-in',
  description: 'Check in to a chapter event with the attendance code shown by the event lead.'
};

export default function CheckInPage() {
  return (
    <div className="container" style={{ maxWidth: 760 }}>
      <PageHeader
        kicker="Chapter events"
        title="Scan check-in"
        description="Duplicate scans are safe — if you already checked in, we simply remind you."
      />
      <Section kicker="Attendance" title="Enter your code">
        <AttendanceCheckIn />
      </Section>
    </div>
  );
}
