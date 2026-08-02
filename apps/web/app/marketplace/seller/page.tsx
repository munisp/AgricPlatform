import type { Metadata } from 'next';
import { PromotionsPanel, ReturnsQueuePanel, SellerAnalyticsPanel } from '@/components/seller-commerce';
import { T } from '@/lib/i18n';
import { PageHeader, Section } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Seller dashboard',
  description: 'Seller revenue, orders, promotions, returns and ratings.'
};

export default function SellerDashboardPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="commerce.sellerKicker" />}
        title={<T k="commerce.sellerTitle" />}
        description={<T k="commerce.sellerDescription" />}
      />

      <Section title={<T k="commerce.sellerTitle" />}>
        <SellerAnalyticsPanel />
      </Section>

      <Section title={<T k="commerce.promotionsTitle" />}>
        <PromotionsPanel />
      </Section>

      <Section title={<T k="commerce.returnsTitle" />}>
        <ReturnsQueuePanel />
      </Section>
    </div>
  );
}
