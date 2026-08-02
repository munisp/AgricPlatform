import type { Metadata } from 'next';
import { MyBookings, SupplierDirectory } from '@/components/services-live';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Services Marketplace',
  description:
    'Verified input and service suppliers — seed, fertiliser, equipment hire, cold storage, labour and insurance — with booking, quotes and reviews.'
};

export default function ServicesPage() {
  return (
    <div className="container">
      <PageHeader
        kicker="Services marketplace"
        title="Book trusted farm services"
        description="Filter suppliers by category and state. Booking requests queue offline and sync with idempotency keys when you reconnect."
      />

      <Section kicker="Directory" title="Suppliers">
        <SupplierDirectory />
      </Section>

      <Section
        kicker="Your requests"
        title="My bookings"
        description="Track each request from quote to completion, then review the supplier."
      >
        <MyBookings />
      </Section>
    </div>
  );
}
