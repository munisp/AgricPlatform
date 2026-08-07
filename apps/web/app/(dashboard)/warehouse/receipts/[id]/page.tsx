import type { Metadata } from 'next';
import { ReceiptDetail } from '@/components/warehouse-live';
import { PageHeader } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Warehouse Receipt',
  description: 'Electronic warehouse receipt detail — signature verification, pledges and ownership history.'
};

export default async function WarehouseReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="container">
      <PageHeader kicker={<T k="warehouse.kicker" />} title={<T k="warehouse.receiptDetail" />} />
      <ReceiptDetail receiptId={id} />
    </div>
  );
}
