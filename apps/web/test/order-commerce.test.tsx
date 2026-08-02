import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { OrderCommercePanel } from '@/components/order-commerce';
import type { Order } from '@agric-platform/shared';

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

const ORDER = {
  id: 'order-1',
  listingId: 'listing-1',
  buyerId: 'user-adamu',
  sellerId: 'user-seller',
  quantity: 2,
  totalNaira: 5000,
  status: 'confirmed',
  escrowRequired: true,
  createdAt: '2026-02-01T00:00:00.000Z'
} as unknown as Order;

const ESCROW = {
  id: 'escrow-1',
  orderId: 'order-1',
  amountKobo: 500_000,
  status: 'held',
  heldAt: '2026-02-01T10:00:00.000Z'
};

const SHIPMENT = {
  id: 'shipment-1',
  orderId: 'order-1',
  status: 'in_transit',
  carrier: 'GIG Logistics',
  trackingReference: 'GIG-12345',
  scheduledPickupAt: '2026-02-02T00:00:00.000Z',
  createdAt: '2026-02-01T11:00:00.000Z',
  updatedAt: '2026-02-02T11:00:00.000Z'
};

const INVOICE = {
  id: 'invoice-1',
  invoiceNumber: 'INV-user-seller-000001',
  orderId: 'order-1',
  sellerId: 'user-seller',
  buyerId: 'user-adamu',
  status: 'issued',
  currency: 'NGN',
  subtotalKobo: 500_000,
  vatKobo: 37_500, // 7.5% VAT
  totalKobo: 537_500,
  lineItems: [
    { description: 'Maize (100kg bag)', quantity: 2, unitPriceKobo: 250_000, totalKobo: 500_000 }
  ],
  issuedAt: '2026-02-01T12:00:00.000Z',
  createdAt: '2026-02-01T12:00:00.000Z'
};

describe('Order commerce depth', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/api/v1/orders/order-1/escrow') && (!init?.method || init.method === 'GET')) {
        return jsonResponse({ data: ESCROW });
      }
      if (path.endsWith('/api/v1/orders/order-1/shipment')) {
        return jsonResponse({ data: SHIPMENT });
      }
      if (path.endsWith('/api/v1/invoices')) {
        return jsonResponse({ data: [INVOICE] });
      }
      return jsonResponse({ data: null });
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('shows the escrow badge and timeline for the order', async () => {
    renderWithProviders(<OrderCommercePanel order={ORDER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Track fulfilment' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Escrow status: held')).toBeTruthy();
    });
    expect(screen.getByText('Held in escrow')).toBeTruthy();
  });

  it('shows the shipment tracker with carrier and progress', async () => {
    renderWithProviders(<OrderCommercePanel order={ORDER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Track fulfilment' }));

    await waitFor(() => {
      expect(screen.getByText(/GIG Logistics/)).toBeTruthy();
    });
    expect(screen.getByText('in transit')).toBeTruthy();
    expect(screen.getByText(/GIG-12345/)).toBeTruthy();
  });

  it('shows the invoice with line items, 7.5% VAT and totals', async () => {
    renderWithProviders(<OrderCommercePanel order={ORDER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Track fulfilment' }));

    await waitFor(() => {
      expect(screen.getByText('INV-user-seller-000001')).toBeTruthy();
    });
    expect(screen.getByText('Maize (100kg bag)')).toBeTruthy();
    expect(screen.getByText(/VAT \(7\.5%\)/).textContent).toContain('₦375');
    expect(screen.getByText(/^Total:/).textContent).toContain('₦5,375');
  });
});
