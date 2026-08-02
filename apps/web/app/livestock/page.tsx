import type { Metadata } from 'next';
import { LivestockHub } from '@/components/livestock-live';
import { T } from '@/lib/i18n';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Livestock',
  description:
    'ALTP livestock registry: national animal IDs, herd lots, ownership transfers and pastoralist profile.'
};

export default function LivestockPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="livestock.kicker" />}
        title={<T k="livestock.title" />}
        description={<T k="livestock.description" />}
      />
      <LivestockHub />
    </div>
  );
}
