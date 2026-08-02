import type { Metadata } from 'next';
import { LivestockHealthHub } from '@/components/livestock-health-live';
import { T } from '@/lib/i18n';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Animal Health',
  description:
    'Vet-signed health ledger, movement permits, recall console and disease surveillance for the ALTP livestock platform.'
};

export default function LivestockHealthPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="livestock.healthKicker" />}
        title={<T k="livestock.healthTitle" />}
        description={<T k="livestock.healthDescription" />}
      />
      <LivestockHealthHub />
    </div>
  );
}
