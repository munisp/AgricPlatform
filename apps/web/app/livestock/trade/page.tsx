import type { Metadata } from 'next';
import { LivestockTradeHub } from '@/components/livestock-trade-live';
import { T } from '@/lib/i18n';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Livestock Trade',
  description:
    'Certified livestock listings with provenance, offtake contracts, export documents, liens, insurance, donor disbursements and compliance export.'
};

export default function LivestockTradePage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="livestock.tradeKicker" />}
        title={<T k="livestock.tradeTitle" />}
        description={<T k="livestock.tradeDescription" />}
      />
      <LivestockTradeHub />
    </div>
  );
}
