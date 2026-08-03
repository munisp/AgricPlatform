import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import {
  InsuranceCatalogSection,
  InsurancePayoutLedgerSection,
  InsuranceQuoteSection,
  InsuranceTriggerMonitorSection,
  MyInsurancePoliciesSection,
  previewPremiumKobo
} from '@/components/insurance-live';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

const PRODUCTS = [
  {
    id: 'insprod-1',
    code: 'NG-RAIN-WET-26',
    name: 'Wet-season rainfall deficit cover',
    description: 'Pays when rainfall falls to or below the threshold.',
    peril: 'RAINFALL_DEFICIT',
    trigger: {
      metric: 'rainfall_mm',
      operator: 'lte',
      threshold: 40,
      h3Resolution: 7,
      observationWindowDays: 30,
      season: '2026-wet'
    },
    payoutTable: [
      { minRatio: 0.5, payoutPercent: 100 },
      { minRatio: 0.25, payoutPercent: 60 },
      { minRatio: 0, payoutPercent: 25 }
    ],
    premiumRateBps: 800,
    createdAt: '2026-01-01T00:00:00.000Z'
  }
];

const PLOTS = [
  {
    id: 'plot-1',
    ownerUserId: 'farmer-1',
    name: 'Zaria North Plot',
    state: 'Kaduna',
    lga: 'Zaria',
    centroidLat: 11.0855,
    centroidLong: 7.7199,
    sizeHectares: 2.5,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1
  }
];

const POLICY = {
  id: 'inspol-1',
  farmerUserId: 'farmer-1',
  plotId: 'plot-1',
  productId: 'insprod-1',
  productCode: 'NG-RAIN-WET-26',
  season: '2026-wet',
  sumInsuredKobo: 1_000_000,
  premiumKobo: 80_000,
  floodBand: 'none',
  pricingBasis: 'stub',
  status: 'quoted',
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z'
};

const TRIGGER_EVENT = {
  id: 'instrig-1',
  policyId: 'inspol-1',
  productId: 'insprod-1',
  farmerUserId: 'farmer-1',
  evidence: {
    h3Cell: '8741e68dfffffff',
    h3Resolution: 7,
    season: '2026-wet',
    windowDays: 30,
    metric: 'rainfall_mm',
    observedValue: 32.5,
    threshold: 40,
    operator: 'lte',
    breachRatio: 0.1875,
    basis: { weather: 'stub', flood: 'unavailable' },
    evaluatedAt: '2026-03-01T00:00:00.000Z'
  },
  evidenceFingerprint: 'deadbeef',
  payoutPercent: 25,
  payoutKobo: 250_000,
  createdAt: '2026-03-01T00:00:00.000Z'
};

const PAYOUT = {
  id: 'inspay-1',
  policyId: 'inspol-1',
  triggerEventId: 'instrig-1',
  farmerUserId: 'farmer-1',
  amountKobo: 250_000,
  status: 'proposed',
  execution: 'stub',
  proposedAt: '2026-03-01T00:00:00.000Z'
};

/** Routes fetch by URL + method to the insurance endpoints. */
function mockApi(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn().mockImplementation(handler);
}

function baseRoutes(overrides: Partial<Record<string, unknown>> = {}) {
  return mockApi((url: string, init?: RequestInit) => {
    if (url.includes('/insurance/products')) return jsonResponse({ data: PRODUCTS });
    if (url.includes('/farms/plots')) return jsonResponse({ data: PLOTS });
    if (url.includes('/insurance/policies/mine'))
      return jsonResponse({ data: overrides.policies ?? [] });
    if (url.includes('/insurance/trigger-events'))
      return jsonResponse({ data: overrides.triggerEvents ?? [] });
    if (url.includes('/insurance/payouts')) return jsonResponse({ data: overrides.payouts ?? [] });
    if (url.includes('/insurance/quotes') && init?.method === 'POST')
      return jsonResponse({ data: { quote: QUOTE, policy: POLICY } });
    if (url.includes('/issue') && init?.method === 'POST')
      return jsonResponse({ data: { ...POLICY, status: 'active' } });
    return jsonResponse({}, 404);
  });
}

const QUOTE = {
  productCode: 'NG-RAIN-WET-26',
  season: '2026-wet',
  sumInsuredKobo: 1_000_000,
  premiumRateBps: 800,
  floodBand: 'none',
  floodModifierBps: 10_000,
  premiumKobo: 80_000,
  pricingBasis: 'stub'
};

function renderWithI18n(node: ReactElement) {
  return render(<I18nProvider>{node}</I18nProvider>);
}

beforeEach(() => clearApiCache());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('previewPremiumKobo (client rate-card mirror)', () => {
  it('matches the server known-answer vectors', () => {
    expect(previewPremiumKobo(1_000_000, 800, 'none')).toBe(80_000);
    expect(previewPremiumKobo(1_000_000, 800, 'high')).toBe(100_000);
    expect(previewPremiumKobo(1_000_000, 800, 'severe')).toBe(120_000);
    expect(previewPremiumKobo(100_000, 600, 'moderate')).toBe(68);
  });
});

describe('InsuranceCatalogSection', () => {
  it('renders the seeded product with trigger summary and payout bands', async () => {
    vi.stubGlobal('fetch', baseRoutes());
    renderWithI18n(<InsuranceCatalogSection />);
    await waitFor(() => screen.getByText('Wet-season rainfall deficit cover'));
    expect(screen.getByText('RAINFALL_DEFICIT')).toBeTruthy();
    expect(screen.getByText(/rainfall_mm ≤ 40 mm over 30d/)).toBeTruthy();
    expect(screen.getByText(/100% \/ 60% \/ 25%/)).toBeTruthy();
  });

  it('shows the empty state when the catalog is empty', async () => {
    vi.stubGlobal('fetch', mockApi(() => jsonResponse({ data: [] })));
    renderWithI18n(<InsuranceCatalogSection />);
    await waitFor(() =>
      screen.getByText('No parametric products are available on this deployment yet.')
    );
  });

  it('shows the error state when the catalog fails to load', async () => {
    vi.stubGlobal('fetch', mockApi(() => jsonResponse({ message: 'down' }, 503)));
    renderWithI18n(<InsuranceCatalogSection />);
    await waitFor(() => screen.getByText('Could not load the product catalog.'));
  });
});

describe('InsuranceQuoteSection', () => {
  it('previews the premium locally and submits the binding quote + issue flow', async () => {
    vi.stubGlobal('fetch', baseRoutes());
    renderWithI18n(<InsuranceQuoteSection />);
    await waitFor(() => screen.getByLabelText('Product'));
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'NG-RAIN-WET-26' } });
    fireEvent.change(screen.getByLabelText('Plot'), { target: { value: 'plot-1' } });
    fireEvent.change(screen.getByLabelText('Sum insured (₦)'), { target: { value: '10000' } });
    await waitFor(() => screen.getByTestId('insurance-quote-preview'));
    expect(screen.getByTestId('insurance-quote-preview').textContent).toContain('800');

    fireEvent.click(screen.getByRole('button', { name: 'Get binding quote' }));
    await waitFor(() => screen.getByTestId('insurance-server-quote'));
    expect(screen.getByText('Pricing data: STUB')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Issue policy' }));
    await waitFor(() => screen.getByText('Policy active — you are covered for the season.'));
  });

  it('surfaces a quote failure notice', async () => {
    vi.stubGlobal(
      'fetch',
      mockApi((url: string, init?: RequestInit) => {
        if (url.includes('/insurance/quotes') && init?.method === 'POST') {
          return jsonResponse({ message: 'bad amount' }, 400);
        }
        if (url.includes('/insurance/products')) return jsonResponse({ data: PRODUCTS });
        if (url.includes('/farms/plots')) return jsonResponse({ data: PLOTS });
        return jsonResponse({ data: [] });
      })
    );
    renderWithI18n(<InsuranceQuoteSection />);
    await waitFor(() => screen.getByLabelText('Product'));
    fireEvent.change(screen.getByLabelText('Product'), { target: { value: 'NG-RAIN-WET-26' } });
    fireEvent.change(screen.getByLabelText('Plot'), { target: { value: 'plot-1' } });
    fireEvent.change(screen.getByLabelText('Sum insured (₦)'), { target: { value: '10000' } });
    await waitFor(() => screen.getByTestId('insurance-quote-preview'));
    fireEvent.click(screen.getByRole('button', { name: 'Get binding quote' }));
    await waitFor(() => screen.getByText('Quote failed — check the amount and try again.'));
  });
});

describe('MyInsurancePoliciesSection', () => {
  it('renders policies with status badges', async () => {
    vi.stubGlobal(
      'fetch',
      baseRoutes({
        policies: [
          { ...POLICY, status: 'active' },
          { ...POLICY, id: 'inspol-2', status: 'payout_proposed' },
          { ...POLICY, id: 'inspol-3', status: 'expired' }
        ]
      })
    );
    renderWithI18n(<MyInsurancePoliciesSection />);
    await waitFor(() => screen.getByText('Active'));
    expect(screen.getByText('Payout proposed')).toBeTruthy();
    expect(screen.getByText('Expired')).toBeTruthy();
  });

  it('shows the empty state with no policies', async () => {
    vi.stubGlobal('fetch', baseRoutes());
    renderWithI18n(<MyInsurancePoliciesSection />);
    await waitFor(() => screen.getByText('No policies yet — price one above.'));
  });
});

describe('InsuranceTriggerMonitorSection', () => {
  it('renders evidence with observed/threshold/margin and basis badges', async () => {
    vi.stubGlobal('fetch', baseRoutes({ triggerEvents: [TRIGGER_EVENT] }));
    renderWithI18n(<InsuranceTriggerMonitorSection />);
    await waitFor(() => screen.getByTestId('insurance-trigger-event'));
    expect(screen.getByText(/32.5/)).toBeTruthy();
    expect(screen.getByText(/18.8%/)).toBeTruthy();
    expect(screen.getByText('Weather data: STUB')).toBeTruthy();
    expect(screen.getByText(/8741e68dfffffff/)).toBeTruthy();
    expect(screen.getByText('25% of sum insured')).toBeTruthy();
  });

  it('shows the empty state with no trigger events', async () => {
    vi.stubGlobal('fetch', baseRoutes());
    renderWithI18n(<InsuranceTriggerMonitorSection />);
    await waitFor(() => screen.getByText(/No trigger events yet/));
  });
});

describe('InsurancePayoutLedgerSection', () => {
  it('renders the payout ledger with the stub execution badge', async () => {
    vi.stubGlobal('fetch', baseRoutes({ payouts: [PAYOUT] }));
    renderWithI18n(<InsurancePayoutLedgerSection />);
    await waitFor(() => screen.getByText('inspol-1'));
    expect(screen.getByText('₦2,500')).toBeTruthy();
    expect(screen.getByText('Payout proposed')).toBeTruthy();
    expect(screen.getByLabelText('STUB — no real disbursement')).toBeTruthy();
  });

  it('shows the empty state with no payouts', async () => {
    vi.stubGlobal('fetch', baseRoutes());
    renderWithI18n(<InsurancePayoutLedgerSection />);
    await waitFor(() => screen.getByText('No payouts yet.'));
  });
});
