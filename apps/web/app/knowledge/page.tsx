import type { Metadata } from 'next';
import {
  MyWebinarRegistrations,
  PodcastList,
  ResourceLibrary,
  WebinarList
} from '@/components/knowledge-live';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Knowledge Base',
  description:
    'Agronomy resources with offline packs, podcasts with full transcripts, and webinars with recordings.'
};

export default function KnowledgePage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Knowledge base"
        title="Learn from the library"
        description="Filter resources by tag, language and format. Offline-ready items can be saved to your device from Settings."
      />

      <Section kicker="Library" title="Resources">
        <ResourceLibrary />
      </Section>

      <Section
        kicker="Audio"
        title="Podcasts"
        description="Every episode ships with a full transcript — listen or read, your choice."
      >
        <PodcastList />
      </Section>

      <Section kicker="Live" title="Webinars">
        <WebinarList />
      </Section>

      <Section kicker="Yours" title="My registrations">
        <MyWebinarRegistrations />
      </Section>
    </div>
  );
}
