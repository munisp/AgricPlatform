import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { en } from '@/lib/i18n/dictionaries/en';
import { ha } from '@/lib/i18n/dictionaries/ha';
import { yo } from '@/lib/i18n/dictionaries/yo';
import { ig } from '@/lib/i18n/dictionaries/ig';
import { ProductsHub } from '@/components/products-hub';
import ProductsPage from '@/app/products/page';
import { ALL_PRODUCTS, PRODUCT_GROUPS } from '@/lib/products';

expect.extend(toHaveNoViolations);

// jsdom cannot compute color contrast — covered by test/contrast.test.ts.
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

/** The ten incoming product areas this hub is built to host. */
const INNOVATION_IDS = [
  'voiceAgronomist',
  'traceability',
  'geoCredit',
  'insurance',
  'warehouseReceipts',
  'agentBanking',
  'carbon',
  'vouchers',
  'livestockPassport',
  'mechanization'
];

function renderHub() {
  return render(
    <AppProvider>
      <I18nProvider>
        <ProductsHub />
      </I18nProvider>
    </AppProvider>
  );
}

describe('/products hub', () => {
  afterEach(() => cleanup());

  it('renders every product group with its dictionary heading', () => {
    renderHub();
    for (const group of PRODUCT_GROUPS) {
      const title = group.titleKey.split('.').pop() as keyof typeof en.products.groups;
      expect(screen.getByRole('heading', { name: en.products.groups[title] })).toBeTruthy();
    }
  });

  it('live products render as links; planned products never do', () => {
    const { container } = renderHub();
    for (const product of ALL_PRODUCTS) {
      const card = container.querySelector(`[data-product="${product.id}"]`);
      expect(card, product.id).toBeTruthy();
      if (product.status === 'planned') {
        expect(product.href, `${product.id} must not have an href`).toBeUndefined();
        expect(card!.tagName).not.toBe('A');
        expect(within(card as HTMLElement).getByText('Coming soon')).toBeTruthy();
      } else {
        expect(product.href, `${product.id} needs an href`).toBeTruthy();
        expect(card!.tagName).toBe('A');
        expect(card!.getAttribute('href')).toBe(product.href);
      }
    }
  });

  it('shows honest status badges (Available / Beta / Coming soon)', () => {
    renderHub();
    expect(screen.getAllByText('Available').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Beta').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Coming soon').length).toBe(INNOVATION_IDS.filter(
      (id) => ALL_PRODUCTS.find((p) => p.id === id)?.status === 'planned'
    ).length);
  });

  it('hosts all ten incoming innovation areas', () => {
    const { container } = renderHub();
    for (const id of INNOVATION_IDS) {
      expect(container.querySelector(`[data-product="${id}"]`), id).toBeTruthy();
    }
  });

  it('product catalogue data is internally consistent', () => {
    const ids = new Set<string>();
    for (const product of ALL_PRODUCTS) {
      expect(ids.has(product.id), `duplicate id ${product.id}`).toBe(false);
      ids.add(product.id);
      if (product.href) expect(product.href.startsWith('/')).toBe(true);
    }
  });

  it('hub copy obeys the low-literacy rules (titles ≤4 words, descs ≤8 words)', () => {
    for (const item of Object.values(en.products.items)) {
      expect(item.title.split(/\s+/).length, item.title).toBeLessThanOrEqual(4);
      expect(item.desc.split(/\s+/).length, item.desc).toBeLessThanOrEqual(8);
      expect(item.title).toBe(item.title.trim());
    }
  });

  it('page header h1 is a programmatic focus target (not in tab order)', () => {
    const { container } = render(
      <AppProvider>
        <I18nProvider>
          <ProductsPage />
        </I18nProvider>
      </AppProvider>
    );
    const h1 = container.querySelector('h1');
    expect(h1?.getAttribute('tabindex')).toBe('-1');
    expect(h1?.textContent).toBe('All products');
  });

  it('ha/yo/ig scaffolds stay empty (no machine translation)', () => {
    expect(Object.keys(ha)).toHaveLength(0);
    expect(Object.keys(yo)).toHaveLength(0);
    expect(Object.keys(ig)).toHaveLength(0);
  });

  it('hub has no axe violations', async () => {
    const { container } = renderHub();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
