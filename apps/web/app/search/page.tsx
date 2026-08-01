import type { Metadata } from 'next';
import { SearchClient } from '@/components/search-client';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Search',
  description: 'Cross-domain search across courses, opportunities, chapters, marketplace listings and advisory.'
};

export default function SearchPage() {
  return (
    <div className="container" style={{ maxWidth: 820 }}>
      <PageHeader
        kicker="Discovery"
        title="Search AgricPlatform"
        description="One search across every module. The production index is powered by the Meilisearch adapter."
      />
      <section className="section-tight">
        <SearchClient />
      </section>
    </div>
  );
}
