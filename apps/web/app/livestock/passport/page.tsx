import type { Metadata } from 'next';
import { LivestockPassportHub } from '@/components/livestock-passport-live';
import { T } from '@/lib/i18n';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Livestock passport',
  description:
    'Digital livestock passport: one verifiable identity document per animal with a hash-chained event log, two-party ownership transfers and public QR verification.'
};

export default function LivestockPassportPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="livestockPassport.kicker" />}
        title={<T k="livestockPassport.title" />}
        description={<T k="livestockPassport.description" />}
      />
      <LivestockPassportHub />
    </div>
  );
}
