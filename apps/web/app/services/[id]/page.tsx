import type { Metadata } from 'next';
import Link from 'next/link';
import { SupplierDetail } from '@/components/services-live';
import { PageHeader } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Supplier',
  description: 'Supplier profile with offerings, aggregate rating and booking requests.'
};

export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="container" style={{ maxWidth: 920 }}>
      <PageHeader
        kicker="Services marketplace"
        title="Supplier detail"
        description={
          <>
            <Link href="/services">← Back to the directory</Link>
          </>
        }
      />
      <SupplierDetail supplierId={id} />
    </div>
  );
}
