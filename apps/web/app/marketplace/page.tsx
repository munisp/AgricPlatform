import type { Metadata } from 'next';
import { formatNaira, seedListings } from '@agric-platform/shared';
import { ListingForm } from '@/components/listing-form';
import { AutoBadge, Card, PageHeader, Section, StatusBadge, Timeline } from '@/components/ui';
import { demoOrders } from '@/lib/content';

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
        <div className="grid grid-3">
          {seedListings.map((listing) => (
            <Card key={listing.id} title={listing.title}>
              <p className="small muted">
                {listing.quantity} {listing.unit} · {listing.location.state}, {listing.location.lga}
                {listing.harvestDate
                  ? ` · harvest ${new Date(listing.harvestDate).toLocaleDateString('en-NG', { dateStyle: 'medium' })}`
                  : ''}
              </p>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 800, fontSize: '1.1rem' }}>{formatNaira(listing.priceNaira)}</span>
                <AutoBadge value={listing.kind} />
              </div>
            </Card>
          ))}
        </div>
      </Section>

      <Section kicker="Sell" title="List produce, inputs or services">
        <ListingForm />
      </Section>

      <Section kicker="Orders" title="Order pipeline" description="Every status change is an order event; escrow states are explicit.">
        <div className="grid grid-2">
          <Card title="How an order flows">
            <Timeline items={ORDER_FLOW} />
          </Card>
          <div className="stack">
            {demoOrders.map((order) => (
              <Card key={order.id}>
                <div className="cluster" style={{ justifyContent: 'space-between' }}>
                  <h3 style={{ margin: 0 }}>Order #{order.id.replace('order-', '')}</h3>
                  <AutoBadge value={order.status} />
                </div>
                <p className="small muted">
                  Listing {order.listingId} · {order.quantity} units ·{' '}
                  {new Date(order.createdAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
                </p>
                <div className="cluster" style={{ justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 700 }}>{formatNaira(order.totalNaira)}</span>
                  {order.escrowRequired ? <StatusBadge tone="warning">escrow held</StatusBadge> : null}
                </div>
              </Card>
            ))}
          </div>
        </div>
      </Section>
    </div>
  );
}
