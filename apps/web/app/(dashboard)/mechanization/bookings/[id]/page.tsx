import type { Metadata } from 'next';
import Link from 'next/link';
import { EquipmentBookingDetail } from '@/components/mechanization-live';
import { PageHeader } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Equipment booking',
  description: 'Booking detail — status timeline, quote breakdown, advisory and actions.'
};

export default async function MechanizationBookingPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="container" style={{ maxWidth: 920 }}>
      <PageHeader
        kicker={<T k="mechanization.kicker" />}
        title={<T k="mechanization.bookingDetail" />}
        description={<Link href="/mechanization">← <T k="mechanization.myBookingsTitle" /></Link>}
      />
      <EquipmentBookingDetail bookingId={id} />
    </div>
  );
}
