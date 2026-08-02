import type { Metadata } from 'next';
import { ClubDirectory, MyPathways, PathwayBrowser } from '@/components/pathways-live';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Pathways',
  description:
    'Student and NYSC pathways with staged progression and evidence, plus the campus club directory.'
};

export default function PathwaysPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Student & NYSC pathways"
        title="Grow stage by stage"
        description="Enrol on a guided pathway, submit evidence for each stage, and find your campus club."
      />

      <Section kicker="Directory" title="Pathway templates">
        <PathwayBrowser />
      </Section>

      <Section
        kicker="Your journey"
        title="My pathway progress"
        description="Evidence you submit offline is queued and synced when you reconnect."
      >
        <MyPathways />
      </Section>

      <Section kicker="Community" title="Campus clubs">
        <ClubDirectory />
      </Section>
    </div>
  );
}
