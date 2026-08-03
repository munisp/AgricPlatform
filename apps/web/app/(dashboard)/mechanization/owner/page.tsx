import type { Metadata } from 'next';
import Link from 'next/link';
import { OwnerDashboard } from '@/components/mechanization-live';
import { PageHeader } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Equipment owner dashboard',
  description: 'Listings, booking queue and utilization for equipment owners.'
};

export default function MechanizationOwnerPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="mechanization.ownerKicker" />}
        title={<T k="mechanization.ownerTitle" />}
        description={<Link href="/mechanization">← <T k="mechanization.kicker" /></Link>}
      />
      <OwnerDashboard />
    </div>
  );
}
