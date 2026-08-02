import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { PromotionsPanel, ReturnsQueuePanel, SellerAnalyticsPanel } from '@/components/seller-commerce';

expect.extend(toHaveNoViolations);

// jsdom does no layout and the stylesheet is not loaded — color contrast is
// covered by test/contrast.test.ts against the CSS source.
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <AppProvider>
      <I18nProvider>{ui}</I18nProvider>
    </AppProvider>
  );
}

const ANALYTICS = {
  sellerId: 'user-adamu',
  revenueKobo: 12_450_000,
  orderCounts: { completed: 8, delivered: 2, cancelled: 1 },
  totalOrders: 11,
  fulfilmentRate: 0.9,
  disputeRate: 0.05,
  returnRate: 0.1,
  topVariants: [
    { variantId: 'v1', sku: 'MAIZE-50KG-A', name: 'Grade A — 50kg bag', unitsSold: 24, revenueKobo: 8_400_000 }
  ],
  sellerRating: { id: 'user-adamu', userId: 'user-adamu', reviewCount: 9, ratingSum: 41, average: 4.56, updatedAt: '2026-08-01T09:00:00.000Z' }
};

const PROMOTIONS = [
  {
    id: 'promo-1',
    code: 'HARVEST10',
    name: 'Harvest week — 10% off',
    kind: 'percentage',
    value: 1000,
    automatic: false,
    usedCount: 14,
    usageLimit: 100,
    isActive: true,
    createdAt: '2026-07-28T08:00:00.000Z',
    updatedAt: '2026-07-28T08:00:00.000Z'
  }
];

const RETURNS = [
  {
    id: 'return-1',
    orderId: 'order-adamu-soya',
    buyerId: 'user-hassan',
    reason: 'Two bags arrived torn',
    status: 'requested',
    restock: true,
    createdAt: '2026-08-02T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z'
  }
];

function router(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const path = new URL(url, 'http://localhost').pathname;
  if (path.includes('/analytics/sellers/')) {
    return jsonResponse({ data: ANALYTICS });
  }
  if (path.endsWith('/promotions')) {
    return jsonResponse({ data: PROMOTIONS });
  }
  if (path.endsWith('/returns')) {
    return jsonResponse({ data: RETURNS });
  }
  return jsonResponse({ data: null }, 404);
}

describe('Seller commerce dashboard (Wave M)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    window.sessionStorage.clear();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(router);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders revenue, rates and top variants from the API', async () => {
    renderWithProviders(<SellerAnalyticsPanel />);
    await waitFor(() => {
      expect(screen.getByText('MAIZE-50KG-A')).toBeTruthy();
    });
    expect(screen.getByText('90%')).toBeTruthy();
    expect(screen.getByText('4.56 / 5')).toBeTruthy();
    expect(screen.getByText('completed: 8')).toBeTruthy();
  });

  it('lists promotions with coupon details', async () => {
    renderWithProviders(<PromotionsPanel />);
    await waitFor(() => {
      expect(screen.getByText('Harvest week — 10% off')).toBeTruthy();
    });
    expect(screen.getByText(/HARVEST10 · 10% off · 14\/100 used/)).toBeTruthy();
  });

  it('lists the return queue with statuses', async () => {
    renderWithProviders(<ReturnsQueuePanel />);
    await waitFor(() => {
      expect(screen.getByText('Two bags arrived torn')).toBeTruthy();
    });
    expect(screen.getByLabelText('Return status: requested')).toBeTruthy();
  });

  it('shows the offline notice with fixture data when the API is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    renderWithProviders(<SellerAnalyticsPanel />);
    await waitFor(() => {
      expect(screen.getByText(/showing reference data/)).toBeTruthy();
    });
    expect(screen.getByText('CASSAVA-25KG-B')).toBeTruthy();
  });

  it('SellerAnalyticsPanel has no axe violations', async () => {
    const { container } = renderWithProviders(<SellerAnalyticsPanel />);
    await waitFor(() => {
      expect(screen.getByText('MAIZE-50KG-A')).toBeTruthy();
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('PromotionsPanel + ReturnsQueuePanel have no axe violations', async () => {
    const { container } = renderWithProviders(
      <>
        <PromotionsPanel />
        <ReturnsQueuePanel />
      </>
    );
    await waitFor(() => {
      expect(screen.getByText('Two bags arrived torn')).toBeTruthy();
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
