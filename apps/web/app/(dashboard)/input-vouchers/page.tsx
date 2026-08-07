import type { Metadata } from 'next';
import {
  BeneficiaryEnrolSection,
  FarmerVoucherSection,
  StubIdentityBadge,
  SubsidyProgrammeSection,
  SubsidyReconciliationSection,
  SupplierRedeemSection,
  VoucherAllocateSection
} from '@/components/input-vouchers-live';
import { PageHeader, Section } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Input Subsidy Vouchers',
  description:
    'NIN-verified input subsidy e-vouchers: programmes, allocation, agro-dealer redemption and reconciliation.'
};

export default function InputVouchersPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="inputVouchers.kicker" />}
        title={<T k="inputVouchers.title" />}
        description={<T k="inputVouchers.description" />}
      />
      <StubIdentityBadge />

      <Section kicker={<T k="inputVouchers.programmesKicker" />} title={<T k="inputVouchers.programmesTitle" />}>
        <SubsidyProgrammeSection />
      </Section>

      <Section kicker={<T k="inputVouchers.enrolKicker" />} title={<T k="inputVouchers.enrolTitle" />}>
        <BeneficiaryEnrolSection />
      </Section>

      <Section kicker={<T k="inputVouchers.allocateKicker" />} title={<T k="inputVouchers.allocateTitle" />}>
        <VoucherAllocateSection />
      </Section>

      <Section kicker={<T k="inputVouchers.farmerKicker" />} title={<T k="inputVouchers.farmerTitle" />}>
        <FarmerVoucherSection />
      </Section>

      <Section kicker={<T k="inputVouchers.redeemKicker" />} title={<T k="inputVouchers.redeemTitle" />}>
        <SupplierRedeemSection />
      </Section>

      <Section kicker={<T k="inputVouchers.reportKicker" />} title={<T k="inputVouchers.reportTitle" />}>
        <SubsidyReconciliationSection />
      </Section>
    </div>
  );
}
