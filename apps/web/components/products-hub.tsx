'use client';

import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { PRODUCT_GROUPS } from '@/lib/products';
import type { ProductDef } from '@/lib/products';
import { StatusBadge } from '@/components/ui';

function statusLabel(status: ProductDef['status']): 'products.statusLive' | 'products.statusBeta' | 'products.statusPlanned' {
  if (status === 'beta') return 'products.statusBeta';
  if (status === 'planned') return 'products.statusPlanned';
  return 'products.statusLive';
}

function ProductCard({ product }: { product: ProductDef }) {
  const { t } = useT();
  const badge = (
    <StatusBadge tone={product.status === 'live' ? 'success' : product.status === 'beta' ? 'info' : 'neutral'}>
      {t(statusLabel(product.status))}
    </StatusBadge>
  );
  const body = (
    <>
      <div className="product-card-head">
        <span className={`product-glyph glyph-${product.glyph}`} aria-hidden="true" />
        {badge}
      </div>
      <span className="product-title">{t(product.titleKey)}</span>
      <span className="product-desc">{t(product.descKey)}</span>
    </>
  );

  // Planned products are honest placeholders: real content, no link.
  if (product.status === 'planned' || !product.href) {
    return (
      <div className="product-card is-planned" data-product={product.id}>
        {body}
      </div>
    );
  }
  return (
    <Link className="product-card" href={product.href} data-product={product.id}>
      {body}
    </Link>
  );
}

/**
 * /products hub: every platform area as a card grid, grouped by journey.
 * Cards are real links (live) or dashed placeholders (planned) so keyboard
 * and screen-reader users get a truthful map of what exists today.
 */
export function ProductsHub() {
  const { t } = useT();
  return (
    <div>
      {PRODUCT_GROUPS.map((group) => (
        <section key={group.id} className="product-group" aria-labelledby={`product-group-${group.id}`}>
          <div className="product-group-head">
            <h2 id={`product-group-${group.id}`} style={{ fontSize: '1.25rem' }}>
              {t(group.titleKey)}
            </h2>
          </div>
          <div className="product-grid">
            {group.products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
