import type { Metadata } from 'next';
import Link from 'next/link';
import {
  DepositForm,
  MyDeposits,
  MyReceipts,
  WarehouseBrowser,
  WarehouseIntegrationBadges
} from '@/components/warehouse-live';
import { PageHeader, Section } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Warehouse Receipts',
  description:
    'Deposit harvest at certified warehouses, receive signed electronic warehouse receipts, pledge them for credit, transfer ownership, or redeem your grain.'
};

export default function WarehousePage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="warehouse.kicker" />}
        title={<T k="warehouse.title" />}
        description={<T k="warehouse.description" />}
      />
      <WarehouseIntegrationBadges />
      <p className="small muted">
        <T k="warehouse.stubNotice" />
      </p>
      <p className="small">
        <Link href="/warehouse/lender">
          <T k="warehouse.lenderBookKicker" /> →
        </Link>
      </p>

      <Section kicker={<T k="warehouse.browseKicker" />} title={<T k="warehouse.browseTitle" />}>
        <WarehouseBrowser />
      </Section>

      <Section kicker={<T k="warehouse.depositKicker" />} title={<T k="warehouse.depositTitle" />}>
        <DepositForm />
      </Section>

      <Section kicker={<T k="warehouse.depositsTitle" />} title={<T k="warehouse.depositsTitle" />}>
        <MyDeposits />
      </Section>

      <Section kicker={<T k="warehouse.receiptsKicker" />} title={<T k="warehouse.receiptsTitle" />}>
        <MyReceipts />
      </Section>
    </div>
  );
}
