import type { Metadata } from 'next';
import { TraceabilityHub } from '@/components/traceability-live';
import { T } from '@/lib/i18n';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Traceability',
  description:
    'EUDR traceability passport: commodity lots, custody hash chain and due-diligence statement export.'
};

export default function TraceabilityPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="traceability.kicker" />}
        title={<T k="traceability.title" />}
        description={<T k="traceability.description" />}
      />
      <TraceabilityHub />
    </div>
  );
}
