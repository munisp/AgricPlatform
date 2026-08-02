import type { Metadata } from 'next';
import { CertificateTable, CourseCatalogue, EnrolmentProgress } from '@/components/learning-live';
import { T } from '@/lib/i18n';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Learning Academy',
  description: 'Offline-ready courses, enrolment progress and verifiable certificates, bridged with Moodle.'
};

export default function LearningPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="learning.kicker" />}
        title={<T k="learning.title" />}
        description={<T k="learning.description" />}
      />

      <Section kicker={<T k="learning.progressKicker" />} title={<T k="learning.progressTitle" />}>
        <EnrolmentProgress />
      </Section>

      <Section kicker={<T k="learning.catalogueKicker" />} title={<T k="learning.catalogueTitle" />} description={<T k="learning.catalogueDescription" />}>
        <CourseCatalogue />
      </Section>

      <Section kicker={<T k="learning.certsKicker" />} title={<T k="learning.certsTitle" />} id="certificates">
        <CertificateTable />
      </Section>
    </div>
  );
}
