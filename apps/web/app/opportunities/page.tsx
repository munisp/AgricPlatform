import type { Metadata } from 'next';
import { OpportunityBrowser } from '@/components/opportunity-browser';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Opportunities',
  description: 'Grants, loans, programmes, jobs, internships, competitions, equipment and land — filtered and matched to your profile.'
};

export default function OpportunitiesPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Opportunity marketplace"
        title="Funding, programmes and jobs"
        description="Filter by type, state and value chain. Applications are queued offline and submitted with idempotency keys when you reconnect."
      />
      <section className="section-tight">
        <OpportunityBrowser />
      </section>
    </div>
  );
}
