import type { Metadata } from 'next';
import { ListingForm } from '@/components/listing-form';
import { ListingBrowser, OrderList } from '@/components/marketplace-live';
import { T } from '@/lib/i18n';
import { Card, PageHeader, Section, Timeline } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Marketplace',
  description: 'Produce, inputs, equipment and services with escrow-ready order states.'
};

const ORDER_FLOW = [
  { id: 'f1', title: 'Requested', description: 'Buyer places a request on a listing.' },
  { id: 'f2', title: 'Negotiating', description: 'Quantity, price and logistics are agreed in-app.' },
  { id: 'f3', title: 'Confirmed + deposit', description: 'Escrow-ready deposit held via Paystack sandbox.', tone: 'warning' as const },
  { id: 'f4', title: 'Fulfilment and delivery', description: 'Transport and delivery milestones tracked as order events.' },
  { id: 'f5', title: 'Completed', description: 'Escrow released to the seller; both sides can review.' }
];

export default function MarketplacePage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="marketplace.kicker" />}
        title={<T k="marketplace.title" />}
        description={<T k="marketplace.description" />}
      />

      <Section kicker={<T k="marketplace.browseKicker" />} title={<T k="marketplace.browseTitle" />}>
        <ListingBrowser />
      </Section>

      <Section kicker={<T k="marketplace.sellKicker" />} title={<T k="marketplace.sellTitle" />}>
        <ListingForm />
      </Section>

      <Section kicker={<T k="marketplace.ordersKicker" />} title={<T k="marketplace.ordersTitle" />} description={<T k="marketplace.ordersDescription" />}>
        <div className="grid grid-2">
          <Card title={<T k="marketplace.orderFlowTitle" />}>
            <Timeline items={ORDER_FLOW} />
          </Card>
          <OrderList />
        </div>
      </Section>
    </div>
  );
}
