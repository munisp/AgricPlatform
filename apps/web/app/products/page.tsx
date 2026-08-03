import type { Metadata } from 'next';
import { T } from '@/lib/i18n';
import { PageHeader } from '@/components/ui';
import { ProductsHub } from '@/components/products-hub';

export const metadata: Metadata = {
  title: 'All products',
  description:
    'Every AgricPlatform product area in one hub — live modules and honest Coming soon placeholders for what is still being built.'
};

export default function ProductsPage() {
  return (
    <div className="container">
      <PageHeader
        kicker={<T k="products.kicker" />}
        title={<T k="products.title" />}
        description={<T k="products.description" />}
      />
      <ProductsHub />
    </div>
  );
}
