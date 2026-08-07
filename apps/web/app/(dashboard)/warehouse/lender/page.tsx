import type { Metadata } from 'next';
import { LenderPledgeBook, RegistryExportSection } from '@/components/warehouse-live';
import { PageHeader, Section } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Warehouse Pledge Book',
  description: 'Lender desk for warehouse-receipt collateral and the regulator audit export.'
};

export default function WarehouseLenderPage() {
  return (
    <div className="container">
      <PageHeader kicker={<T k="warehouse.lenderBookKicker" />} title={<T k="warehouse.lenderBookTitle" />} />
      <Section kicker={<T k="warehouse.pledgesTitle" />} title={<T k="warehouse.lenderBookTitle" />}>
        <LenderPledgeBook />
      </Section>
      <Section kicker={<T k="warehouse.exportKicker" />} title={<T k="warehouse.exportTitle" />}>
        <RegistryExportSection />
      </Section>
    </div>
  );
}
