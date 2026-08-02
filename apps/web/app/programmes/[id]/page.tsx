import type { Metadata } from 'next';
import Link from 'next/link';
import { CohortDetail } from '@/components/programmes-live';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Programme cohort',
  description: 'Cohort detail with milestones, progress, protected threads and leaderboard.'
};

export default async function CohortPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="container" style={{ maxWidth: 920 }}>
      <PageHeader
        kicker="Programmes"
        title="Cohort detail"
        description={
          <>
            <Link href="/programmes">← Back to all cohorts</Link>
          </>
        }
      />
      <CohortDetail cohortId={id} />
    </div>
  );
}
