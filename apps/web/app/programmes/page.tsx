import type { Metadata } from 'next';
import { CohortDirectory, MyCohorts } from '@/components/programmes-live';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Programmes',
  description:
    'Women-in-agribusiness and youth programme cohorts with milestones, protected member spaces and judged leaderboards.'
};

export default function ProgrammesPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Women & youth programmes"
        title="Cohorts that move with you"
        description="Enrol with self-declared details only. Milestones, threads and judging leaderboards work offline-first."
      />

      <Section kicker="Directory" title="Programme cohorts">
        <CohortDirectory />
      </Section>

      <Section
        kicker="Your programmes"
        title="My cohorts"
        description="Your enrolments and milestone progress, synced from your account when online."
      >
        <MyCohorts />
      </Section>
    </div>
  );
}
