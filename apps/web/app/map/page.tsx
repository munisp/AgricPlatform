import type { Metadata } from 'next';
import { GeoPortal } from '@/components/geoportal/geoportal';
import { PageHeader } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Plot map',
  description:
    'Interactive farm-plot map: walked plot boundaries and carbon H3 cells over state/LGA boundaries, with client-side spatial queries (GeoLibre stack: MapLibre GL + DuckDB-WASM).'
};

export default function MapPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="geoportal.kicker" />}
        title={<T k="geoportal.title" />}
        description={<T k="geoportal.description" />}
      />
      <GeoPortal />
    </div>
  );
}
