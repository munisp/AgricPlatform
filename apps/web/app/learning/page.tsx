import type { Metadata } from 'next';
import { seedCourses } from '@agric-platform/shared';
import { AutoBadge, Card, PageHeader, ProgressBar, Section, StatusBadge } from '@/components/ui';
import { demoCertificates } from '@/lib/content';

export const metadata: Metadata = {
  title: 'Learning Academy',
  description: 'Offline-ready courses, enrolment progress and verifiable certificates, bridged with Moodle.'
};

const ENROLMENTS = [
  { courseId: 'course-agribusiness-finance', progress: 100, status: 'completed' },
  { courseId: 'course-cassava-foundations', progress: 100, status: 'completed' },
  { courseId: 'course-post-harvest', progress: 45, status: 'in_progress' }
];

export default function LearningPage() {
  const courseById = new Map(seedCourses.map((course) => [course.id, course]));

  return (
    <div className="container">
      <PageHeader
        kicker="Learning Academy"
        title="Skills that pay on the farm"
        description="Short, practical courses you can download and finish offline. Certificates carry verification codes partners can check."
      />

      <Section kicker="My learning" title="Enrolment progress">
        <div className="grid grid-3">
          {ENROLMENTS.map((enrolment) => {
            const course = courseById.get(enrolment.courseId);
            if (!course) return null;
            return (
              <Card key={enrolment.courseId} title={course.title}>
                <div className="cluster" style={{ marginBottom: '0.6rem' }}>
                  <AutoBadge value={enrolment.status} />
                  <span className="small muted">{course.category}</span>
                </div>
                <ProgressBar value={enrolment.progress} label="Progress" />
              </Card>
            );
          })}
        </div>
      </Section>

      <Section kicker="Catalogue" title="Course catalogue" description="Mirrored from the Moodle bridge; offline-ready courses download to your device.">
        <div className="grid grid-3">
          {seedCourses.map((course) => (
            <Card key={course.id} title={course.title}>
              <p className="small muted">
                {course.category} · {course.level} · {course.durationMinutes} minutes ·{' '}
                {course.enrolmentCount.toLocaleString('en-NG')} enrolled
              </p>
              <div className="cluster">
                <StatusBadge tone={course.offlineAvailable ? 'success' : 'neutral'}>
                  {course.offlineAvailable ? 'offline-ready' : 'online only'}
                </StatusBadge>
                <StatusBadge tone="info">{course.level}</StatusBadge>
              </div>
            </Card>
          ))}
        </div>
      </Section>

      <Section kicker="Credentials" title="Certificates" id="certificates">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Course</th>
                <th>Verification code</th>
                <th>Issued</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {demoCertificates.map((cert) => (
                <tr key={cert.id}>
                  <td>{courseById.get(cert.courseId)?.title ?? cert.courseId}</td>
                  <td>
                    <code>{cert.verificationCode}</code>
                  </td>
                  <td>{new Date(cert.issuedAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</td>
                  <td>
                    <StatusBadge tone="success">verifiable</StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
