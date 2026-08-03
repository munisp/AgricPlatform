import type { Metadata } from 'next';
import { GeoClusterMap } from '@/components/geo-cluster-map';
import { PageHeader, Section } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Farm cluster map',
  description:
    'Geospatial admin view: H3-indexed farm plots clustered per grid cell, with index rebuild controls.'
};

export default function AdminGeoPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="geo.kicker" />}
        title={<T k="geo.title" />}
        description={<T k="geo.description" />}
      />
      <Section kicker={<T k="geo.mapKicker" />} title={<T k="geo.mapTitle" />}>
        <GeoClusterMap />
      </Section>
    </div>
  );
}
