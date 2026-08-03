import type { Metadata } from 'next';
import { FarmsHub } from '@/components/farms-live';
import { T } from '@/lib/i18n';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Farms',
  description:
    'Farm plots with GPS boundaries, crop plantings, harvest records and per-plot expenses.'
};

export default function FarmsPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="farms.kicker" />}
        title={<T k="farms.title" />}
        description={<T k="farms.description" />}
      />
      <FarmsHub />
    </div>
  );
}
