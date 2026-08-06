import type { Metadata } from 'next';
import Link from 'next/link';
import { EquipmentListingDetail } from '@/components/mechanization-live';
import { PageHeader } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Equipment listing',
  description: 'Equipment listing detail — rates, operator verification, service area and booking.'
};

export default async function MechanizationListingPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="container" style={{ maxWidth: 920 }}>
      <PageHeader
        kicker={<T k="mechanization.kicker" />}
        title={<T k="mechanization.listingDetail" />}
        description={<Link href="/mechanization">← <T k="mechanization.browseTitle" /></Link>}
      />
      <EquipmentListingDetail listingId={id} />
    </div>
  );
}
