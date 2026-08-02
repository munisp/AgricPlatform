import type { Metadata } from 'next';
import { OpportunityBrowser } from '@/components/opportunity-browser';
import { T } from '@/lib/i18n';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Opportunities',
  description: 'Grants, loans, programmes, jobs, internships, competitions, equipment and land — filtered and matched to your profile.'
};

export default function OpportunitiesPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="opportunities.kicker" />}
        title={<T k="opportunities.title" />}
        description={<T k="opportunities.description" />}
      />
      <section className="section-tight">
        <OpportunityBrowser />
      </section>
    </div>
  );
}
