import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import {
  DepositForm,
  LenderPledgeBook,
  MyReceipts,
  ReceiptDetail,
  RegistryExportSection,
  WarehouseBrowser,
  WarehouseIntegrationBadges
} from '@/components/warehouse-live';

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

function previewRole(role: string, userId: string) {
  window.sessionStorage.setItem(
    'agric.session',
    JSON.stringify({ userId, displayName: role, role, isDevPreview: true })
  );
}

const WAREHOUSE = {
  id: 'warehouse-1',
  name: 'Kano Grains Depot',
  state: 'Kano',
  lga: 'Nassarawa',
  latitude: 12.0022,
  longitude: 8.592,
  h3Cell: '872e44d93ffffff',
  capacityTonnes: 500,
  certificationStatus: 'certified',
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z'
};

const RECEIPT = {
  id: 'whr-1',
  receiptNumber: 'WHR-2026-3F9A1C2E',
  depositId: 'whdeposit-1',
  warehouseId: 'warehouse-1',
  ownerId: 'user-farmer',
  crop: 'maize',
  grade: 'A',
  bagCount: 40,
  weightKg: 2000,
  status: 'active',
  nonce: 'nonce-1',
  signature: 'a'.repeat(64),
  issuedAt: '2026-02-03T00:00:00.000Z',
  createdAt: '2026-02-03T00:00:00.000Z',
  updatedAt: '2026-02-03T00:00:00.000Z'
};

const PLEDGE = {
  id: 'whpledge-1',
  receiptId: 'whr-1',
  lenderId: 'user-lender',
  borrowerId: 'user-farmer',
  principalKobo: 5_000_000,
  terms: '90 days',
  status: 'active',
  registryRef: 'STUB-ABCDEF123456',
  registryBasis: 'stub',
  registeredAt: '2026-02-04T00:00:00.000Z',
  createdAt: '2026-02-04T00:00:00.000Z',
  updatedAt: '2026-02-04T00:00:00.000Z'
};

const STATUS = { certificationDriver: 'stub', collateralRegistryDriver: 'stub' };

type Route = { body: unknown; method?: string };

/** Routes the stubbed fetch by API path suffix (optionally method); unmatched paths 404. */
function stubApi(fetchMock: ReturnType<typeof vi.fn>, routes: Record<string, unknown | Route>) {
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    const path = new URL(String(url)).pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const [suffix, entry] of Object.entries(routes)) {
      const route: Route =
        typeof entry === 'object' && entry !== null && 'body' in (entry as Route)
          ? (entry as Route)
          : { body: entry };
      if (path.endsWith(suffix) && (!route.method || route.method === method)) {
        return jsonResponse(route.body);
      }
    }
    return jsonResponse({ error: 'not found' }, 404);
  });
}

function setup(role = 'farmer', userId = 'user-farmer') {
  const fetchMock = vi.fn();
  clearApiCache();
  window.localStorage.clear();
  window.sessionStorage.clear();
  previewRole(role, userId);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => cleanup());

describe('WarehouseBrowser', () => {
  it('renders certified warehouses with capacity and certification badge', async () => {
    const fetchMock = setup();
    stubApi(fetchMock, { '/warehouse/warehouses': { data: [WAREHOUSE] } });
    renderWithProviders(<WarehouseBrowser />);
    await waitFor(() => expect(screen.getByText('Kano Grains Depot')).toBeTruthy());
    expect(screen.getByText(/500 tonnes/)).toBeTruthy();
    expect(screen.getAllByText('certified').length).toBeGreaterThan(0);
  });

  it('shows the empty state when no warehouses match', async () => {
    const fetchMock = setup();
    stubApi(fetchMock, { '/warehouse/warehouses': { data: [] } });
    renderWithProviders(<WarehouseBrowser />);
    await waitFor(() =>
      expect(screen.getByText('No warehouses match these filters yet.')).toBeTruthy()
    );
  });
});

describe('MyReceipts', () => {
  it('lists owned receipts with crop, grade and weight', async () => {
    const fetchMock = setup();
    stubApi(fetchMock, { '/warehouse/receipts/mine': { data: [RECEIPT] } });
    renderWithProviders(<MyReceipts />);
    await waitFor(() => expect(screen.getByText('WHR-2026-3F9A1C2E')).toBeTruthy());
    expect(screen.getByText(/maize/)).toBeTruthy();
    expect(screen.getByText(/2,000 kg|2000 kg/)).toBeTruthy();
  });

  it('shows the empty state when the farmer has no receipts', async () => {
    const fetchMock = setup();
    stubApi(fetchMock, { '/warehouse/receipts/mine': { data: [] } });
    renderWithProviders(<MyReceipts />);
    await waitFor(() =>
      expect(screen.getByText('No receipts yet — deposit a crop lot first.')).toBeTruthy()
    );
  });
});

describe('ReceiptDetail', () => {
  it('verifies the signature and shows the valid badge', async () => {
    const fetchMock = setup();
    stubApi(fetchMock, {
      '/warehouse/receipts/whr-1/verify': { data: { receiptNumber: RECEIPT.receiptNumber, valid: true } },
      '/warehouse/receipts/whr-1/pledges': { data: [] },
      '/warehouse/receipts/whr-1/transfers': { data: [] },
      '/warehouse/receipts/whr-1': { data: RECEIPT }
    });
    renderWithProviders(<ReceiptDetail receiptId="whr-1" />);
    await waitFor(() => expect(screen.getByText('WHR-2026-3F9A1C2E')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Verify signature' }));
    await waitFor(() => expect(screen.getByText('Signature valid')).toBeTruthy());
  });

  it('registers a pledge and shows the STUB-labelled registry reference', async () => {
    const fetchMock = setup();
    let pledged = false;
    stubApi(fetchMock, {
      '/warehouse/receipts/whr-1/pledges': { data: [] },
      '/warehouse/receipts/whr-1/transfers': { data: [] },
      '/warehouse/receipts/whr-1/pledge': { body: { data: { receipt: RECEIPT, pledge: PLEDGE } }, method: 'POST' },
      '/warehouse/receipts/whr-1': { data: RECEIPT }
    });
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      const path = new URL(String(url)).pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (path.endsWith('/warehouse/receipts/whr-1/pledge') && method === 'POST') {
        pledged = true;
        return jsonResponse({ data: { receipt: { ...RECEIPT, status: 'pledged' }, pledge: PLEDGE } });
      }
      if (path.endsWith('/warehouse/receipts/whr-1/pledges')) {
        return jsonResponse({ data: pledged ? [PLEDGE] : [] });
      }
      if (path.endsWith('/warehouse/receipts/whr-1/transfers')) {
        return jsonResponse({ data: [] });
      }
      if (path.endsWith('/warehouse/receipts/whr-1')) {
        return jsonResponse({ data: pledged ? { ...RECEIPT, status: 'pledged' } : RECEIPT });
      }
      return jsonResponse({ error: 'not found' }, 404);
    });
    renderWithProviders(<ReceiptDetail receiptId="whr-1" />);
    await waitFor(() => expect(screen.getByText('WHR-2026-3F9A1C2E')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Loan principal (₦)'), { target: { value: '50000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register pledge' }));
    // Whole-naira house style: ₦50,000 — never decimals.
    await waitFor(() => expect(screen.getAllByText('₦50,000').length).toBeGreaterThan(0));
    expect(screen.getAllByText('STUB-ABCDEF123456').length).toBeGreaterThan(0);
  });

  it('shows the transfer and redeem actions only while transferable', async () => {
    const fetchMock = setup();
    stubApi(fetchMock, {
      '/warehouse/receipts/whr-1/pledges': { data: [PLEDGE] },
      '/warehouse/receipts/whr-1/transfers': { data: [] },
      '/warehouse/receipts/whr-1': { data: { ...RECEIPT, status: 'pledged' } }
    });
    renderWithProviders(<ReceiptDetail receiptId="whr-1" />);
    await waitFor(() => expect(screen.getByText('WHR-2026-3F9A1C2E')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Redeem (withdraw grain)' })).toBeNull();
    expect(screen.queryByText('Transfer ownership')).toBeNull();
  });
});

describe('LenderPledgeBook', () => {
  it('renders the pledge book with whole-naira principals and STUB basis', async () => {
    const fetchMock = setup('lender', 'user-lender');
    stubApi(fetchMock, { '/warehouse/pledges/mine': { data: [PLEDGE] } });
    renderWithProviders(<LenderPledgeBook />);
    await waitFor(() => expect(screen.getByText('₦50,000')).toBeTruthy());
    expect(screen.getByText('STUB')).toBeTruthy();
  });
});

describe('RegistryExportSection', () => {
  it('renders the audit export counts', async () => {
    const fetchMock = setup('regulator', 'user-regulator');
    stubApi(fetchMock, {
      '/warehouse/registry/export': {
        data: {
          receipts: [RECEIPT],
          pledges: [PLEDGE],
          transfers: [],
          exportedAt: '2026-02-05T00:00:00.000Z'
        }
      }
    });
    renderWithProviders(<RegistryExportSection />);
    await waitFor(() =>
      expect(screen.getByTestId('warehouse-export-counts').textContent).toContain(
        '1 receipts · 1 pledges · 0 transfers'
      )
    );
  });
});

describe('WarehouseIntegrationBadges', () => {
  it('labels both external ports as STUB', async () => {
    const fetchMock = setup();
    stubApi(fetchMock, { '/warehouse/integrations/status': { data: STATUS } });
    renderWithProviders(<WarehouseIntegrationBadges />);
    await waitFor(() =>
      expect(screen.getByTestId('warehouse-integration-badges').textContent).toContain('STUB')
    );
    expect(screen.getByTestId('warehouse-integration-badges').textContent).not.toContain('LIVE');
  });
});

describe('DepositForm', () => {
  it('posts a deposit and confirms receipt', async () => {
    const fetchMock = setup();
    stubApi(fetchMock, {
      '/warehouse/warehouses': { data: [WAREHOUSE] },
      '/warehouse/deposits': {
        body: {
          data: {
            id: 'whdeposit-1',
            warehouseId: WAREHOUSE.id,
            farmerId: 'user-farmer',
            crop: 'maize',
            status: 'received',
            createdAt: '2026-02-03T00:00:00.000Z',
            updatedAt: '2026-02-03T00:00:00.000Z'
          }
        },
        method: 'POST'
      }
    });
    renderWithProviders(<DepositForm />);
    await waitFor(() => expect(screen.getByText(/Kano Grains Depot/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Warehouse'), { target: { value: WAREHOUSE.id } });
    fireEvent.change(screen.getByLabelText('Crop'), { target: { value: 'maize' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deposit lot' }));
    await waitFor(() =>
      expect(screen.getByText('Deposit received — the warehouse will grade it next.')).toBeTruthy()
    );
  });
});
