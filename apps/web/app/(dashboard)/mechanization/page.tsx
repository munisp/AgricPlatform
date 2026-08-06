import type { Metadata } from 'next';
import Link from 'next/link';
import { EquipmentBrowser, MyEquipmentBookings } from '@/components/mechanization-live';
import { PageHeader, Section } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Mechanization Marketplace',
  description:
    'Hire tractors, planters, harvesters, sprayer drones and threshers from verified cooperative and individual owners — with escrowed payment holds and schedule conflict protection.'
};

export default function MechanizationPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="mechanization.kicker" />}
        title={<T k="mechanization.title" />}
        description={<T k="mechanization.description" />}
      />
      <p className="small">
        <Link href="/mechanization/owner">
          <T k="mechanization.ownerKicker" /> →
        </Link>
      </p>

      <Section kicker={<T k="mechanization.browseKicker" />} title={<T k="mechanization.browseTitle" />}>
        <EquipmentBrowser />
      </Section>

      <Section kicker={<T k="mechanization.myBookingsTitle" />} title={<T k="mechanization.myBookingsTitle" />}>
        <MyEquipmentBookings />
      </Section>
    </div>
  );
}
