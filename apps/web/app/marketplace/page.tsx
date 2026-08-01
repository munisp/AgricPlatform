import type { Metadata } from 'next';
import { ListingForm } from '@/components/listing-form';
import { ListingBrowser, OrderList } from '@/components/marketplace-live';
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
        kicker="Marketplace"
        title="Buy and sell with confidence"
        description="Verified listings, transparent order states and escrow-ready payments built for low connectivity."
      />

      <Section kicker="Browse" title="Active listings">
        <ListingBrowser />
      </Section>

      <Section kicker="Sell" title="List produce, inputs or services">
        <ListingForm />
      </Section>

      <Section kicker="Orders" title="Order pipeline" description="Every status change is an order event; escrow states are explicit.">
        <div className="grid grid-2">
          <Card title="How an order flows">
            <Timeline items={ORDER_FLOW} />
          </Card>
          <OrderList />
        </div>
      </Section>
    </div>
  );
}
