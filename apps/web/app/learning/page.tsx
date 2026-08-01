import type { Metadata } from 'next';
import { CertificateTable, CourseCatalogue, EnrolmentProgress } from '@/components/learning-live';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Learning Academy',
  description: 'Offline-ready courses, enrolment progress and verifiable certificates, bridged with Moodle.'
};

export default function LearningPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Learning Academy"
        title="Skills that pay on the farm"
        description="Short, practical courses you can download and finish offline. Certificates carry verification codes partners can check."
      />

      <Section kicker="My learning" title="Enrolment progress">
        <EnrolmentProgress />
      </Section>

      <Section kicker="Catalogue" title="Course catalogue" description="Mirrored from the Moodle bridge; offline-ready courses download to your device.">
        <CourseCatalogue />
      </Section>

      <Section kicker="Credentials" title="Certificates" id="certificates">
        <CertificateTable />
      </Section>
    </div>
  );
}
