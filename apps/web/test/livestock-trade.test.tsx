import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import type { MarketplaceListing } from '@agric-platform/shared';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import {
  CertifiedListingsPanel,
  ComplianceExportCard,
  DisbursementsPanel,
  InsurancePanel,
  LiensConsole
} from '@/components/livestock-trade-live';
import { LivestockProvenanceBadge } from '@/components/livestock-provenance-badge';
import { LivestockSummaryCard } from '@/components/livestock-dashboard-widget';

expect.extend(toHaveNoViolations);

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

function previewRole(role: string, userId: string) {
  window.sessionStorage.setItem(
    'agric.session',
    JSON.stringify({ userId, displayName: role, role, isDevPreview: true })
  );
}

const LISTING = {
  id: 'listing-cert-1',
  subjectType: 'animal',
  subjectId: 'NG-BOV-KD-000123',
  sellerUserId: 'user-adamu',
  species: 'cattle',
  breed: 'White Fulani',
  askingPriceKobo: 45_000_000,
  status: 'draft',
  provenance: {
    subjectType: 'animal',
    subjectId: 'NG-BOV-KD-000123',
    species: 'cattle',
    breed: 'White Fulani',
    ownershipDepth: 1,
    consentGranted: true
  },
  createdAt: '2026-07-20T09:00:00.000Z',
  updatedAt: '2026-07-21T09:00:00.000Z'
};

const LIEN = {
  id: 'lien-1',
  subjectType: 'animal',
  subjectId: 'NG-BOV-KD-000123',
  lenderUserId: 'user-lender',
  borrowerUserId: 'user-adamu',
  principalKobo: 30_000_000,
  terms: '6-month input credit.',
  status: 'active',
  registeredAt: '2026-06-05T09:00:00.000Z',
  createdAt: '2026-06-05T09:00:00.000Z',
  updatedAt: '2026-06-05T09:00:00.000Z'
};

const POLICY = {
  id: 'policy-1',
  holderUserId: 'user-adamu',
  insurerUserId: 'user-insurer',
  subjectType: 'animal',
  subjectId: 'NG-BOV-KD-000123',
  species: 'cattle',
  premiumKobo: 2_250_000,
  coverageKobo: 45_000_000,
  status: 'quote',
  createdAt: '2026-06-28T10:00:00.000Z',
  updatedAt: '2026-06-28T10:00:00.000Z'
};

const CLAIM = {
  id: 'claim-1',
  policyId: 'policy-1',
  claimantUserId: 'user-adamu',
  trigger: 'recall',
  recallId: 'recall-1',
  animalIds: ['NG-BOV-KD-000123'],
  status: 'submitted',
  createdAt: '2026-07-19T09:00:00.000Z',
  updatedAt: '2026-07-19T09:00:00.000Z'
};

const DISBURSEMENT = {
  id: 'disb-1',
  donorUserId: 'user-donor',
  programmeId: 'prog-women-poultry',
  milestone: 'vaccination',
  amountKobo: 5_000_000,
  beneficiaryUserId: 'user-adamu',
  status: 'scheduled',
  createdAt: '2026-07-26T08:00:00.000Z',
  updatedAt: '2026-07-26T08:00:00.000Z'
};

const ANIMAL = {
  id: 'NG-BOV-KD-000123',
  species: 'cattle',
  breed: 'White Fulani',
  sex: 'female',
  ownerUserId: 'user-adamu',
  state: 'Kaduna',
  status: 'alive',
  createdAt: '2026-05-02T08:00:00.000Z',
  updatedAt: '2026-05-02T08:00:00.000Z'
};

function router(url: string, init?: RequestInit) {
  const path = new URL(url).pathname;
  const method = init?.method ?? 'GET';

  if (path.endsWith('/api/v1/livestock-trade/listings/mine')) return jsonResponse({ data: [LISTING] });
  if (path.endsWith('/api/v1/livestock-trade/listings') && method === 'POST') {
    return jsonResponse({ data: { ...LISTING, id: 'listing-new' } });
  }
  if (path.endsWith('/api/v1/livestock-trade/listings/listing-cert-1/activate')) {
    return jsonResponse({ data: { ...LISTING, status: 'active' } });
  }
  if (path.endsWith('/api/v1/livestock-trade/listings/listing-cert-1')) {
    return jsonResponse({ data: { ...LISTING, status: 'active' } });
  }
  if (path.endsWith('/api/v1/livestock-finance/liens/mine')) return jsonResponse({ data: [LIEN] });
  if (path.endsWith('/api/v1/livestock-finance/liens/lien-1/discharge')) {
    return jsonResponse({ data: { ...LIEN, status: 'discharged' } });
  }
  if (path.endsWith('/api/v1/livestock-finance/liens') && method === 'POST') {
    return jsonResponse({ data: { ...LIEN, id: 'lien-new' } });
  }
  if (path.endsWith('/api/v1/livestock-finance/liens')) return jsonResponse({ data: [LIEN] });
  if (path.endsWith('/api/v1/livestock-finance/insurance/policies/mine')) {
    return jsonResponse({ data: [POLICY] });
  }
  if (path.endsWith('/api/v1/livestock-finance/insurance/quotes') && method === 'POST') {
    return jsonResponse({ data: { ...POLICY, id: 'policy-new' } });
  }
  if (path.endsWith('/api/v1/livestock-finance/insurance/policies/policy-1/bind')) {
    return jsonResponse({ data: { ...POLICY, status: 'bound' } });
  }
  if (path.endsWith('/api/v1/livestock-finance/insurance/claims')) {
    return jsonResponse({ data: [CLAIM] });
  }
  if (path.endsWith('/api/v1/livestock-finance/disbursements/mine')) {
    return jsonResponse({ data: [DISBURSEMENT] });
  }
  if (path.endsWith('/api/v1/livestock-finance/disbursements') && method === 'POST') {
    return jsonResponse({ data: { ...DISBURSEMENT, id: 'disb-new' } });
  }
  if (path.endsWith('/api/v1/livestock-finance/disbursements/disb-1/release')) {
    return jsonResponse({ data: { ...DISBURSEMENT, status: 'released' } });
  }
  if (path.endsWith('/api/v1/livestock/animals/mine')) return jsonResponse({ data: [ANIMAL] });
  if (path.endsWith(`/api/v1/livestock-health/animals/${ANIMAL.id}/records`)) {
    return jsonResponse({ data: [] });
  }
  if (path.endsWith('/api/v1/livestock-health/vaccinations/due')) {
    // One overdue scheduled vaccination for the single alive animal.
    return jsonResponse({
      data: [
        {
          animalId: ANIMAL.id,
          vaccine: 'FMD',
          dueDate: '2026-06-01T00:00:00.000Z',
          daysOverdue: 12,
          status: 'overdue'
        }
      ]
    });
  }
  if (path.endsWith('/api/v1/livestock-health/recalls')) {
    return jsonResponse(
      {
        statusCode: 403,
        error: 'Forbidden',
        message: 'Insufficient role',
        path: '/api/v1/livestock-health/recalls',
        timestamp: '2026-08-01T00:00:00.000Z'
      },
      403
    );
  }
  return jsonResponse({ data: null });
}

const CROP_LISTING: MarketplaceListing = {
  id: 'listing-crop-1',
  sellerId: 'user-aisha',
  kind: 'produce',
  title: '50kg bags of maize',
  crop: 'Maize',
  quantity: 500,
  unit: 'kg',
  priceNaira: 210_000,
  location: { state: 'Kano', lga: 'Kano Municipal' },
  harvestDate: '2026-07-01',
  isActive: true
};

const LIVESTOCK_LISTING: MarketplaceListing = {
  ...CROP_LISTING,
  id: 'listing-cert-1',
  title: 'Certified White Fulani cattle',
  crop: 'Cattle'
};

describe('Livestock trade', () => {
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
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  });

  it('creates a certified listing with kobo conversion and shows the provenance card', async () => {
    renderWithProviders(<CertifiedListingsPanel />);
    await waitFor(() => {
      expect(screen.getByText('listing-cert-1')).toBeTruthy();
    });
    // Provenance card: ownership depth + certification status.
    expect(screen.getByText(/1 transfer/)).toBeTruthy();
    expect(screen.getByLabelText('Certification status: draft')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Subject ID'), { target: { value: 'NG-CAP-KD-000045' } });
    fireEvent.change(screen.getByLabelText(/Asking price/), { target: { value: '450000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create certified listing' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          new URL(String(url)).pathname.endsWith('/api/v1/livestock-trade/listings') &&
          (init as RequestInit)?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toMatchObject({
        subjectType: 'animal',
        subjectId: 'NG-CAP-KD-000045',
        askingPriceKobo: 45_000_000
      });
    });
  });

  it('activates a draft listing through the lifecycle action', async () => {
    renderWithProviders(<CertifiedListingsPanel />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Activate' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/api/v1/livestock-trade/listings/listing-cert-1/activate')
      );
      expect(call).toBeTruthy();
    });
  });

  it('gates the liens console to lenders and discharges a lien', async () => {
    renderWithProviders(<LiensConsole />);
    expect(screen.getByTestId('role-gate-hint')).toBeTruthy();
    cleanup();
    clearApiCache();

    previewRole('lender', 'user-lender');
    renderWithProviders(<LiensConsole />);
    await waitFor(() => {
      expect(screen.getByText(/6-month input credit/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Discharge lien lien-1' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/api/v1/livestock-finance/liens/lien-1/discharge')
      );
      expect(call).toBeTruthy();
    });
  });

  it('quotes, binds and shows recall-triggered claims', async () => {
    renderWithProviders(<InsurancePanel />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Bind policy policy-1' })).toBeTruthy();
    });

    // Quote → POST /insurance/quotes with kobo conversion.
    fireEvent.change(screen.getByLabelText('Subject ID'), { target: { value: 'NG-BOV-KD-000123' } });
    fireEvent.change(screen.getByLabelText('Premium (₦)'), { target: { value: '22500' } });
    fireEvent.change(screen.getByLabelText('Coverage (₦)'), { target: { value: '450000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          new URL(String(url)).pathname.endsWith('/api/v1/livestock-finance/insurance/quotes') &&
          (init as RequestInit)?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toMatchObject({ premiumKobo: 2_250_000, coverageKobo: 45_000_000 });
    });

    // Bind the quote.
    fireEvent.click(screen.getByRole('button', { name: 'Bind policy policy-1' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/api/v1/livestock-finance/insurance/policies/policy-1/bind')
      );
      expect(call).toBeTruthy();
    });

    // Claims view shows the recall-triggered marker.
    fireEvent.click(screen.getByRole('button', { name: 'Claims' }));
    await waitFor(() => {
      expect(screen.getByText(/recall-triggered/)).toBeTruthy();
    });
    expect(screen.getByLabelText(/Recall-triggered claim, recall recall-1/)).toBeTruthy();
  });

  it('gates disbursements to donors and releases a scheduled disbursement', async () => {
    previewRole('donor', 'user-donor');
    renderWithProviders(<DisbursementsPanel />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Release disbursement disb-1' })).toBeTruthy();
    });
    expect(screen.getByLabelText('Milestone: vaccination')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Release disbursement disb-1' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/api/v1/livestock-finance/disbursements/disb-1/release')
      );
      expect(call).toBeTruthy();
    });
  });

  it('gates the compliance export to regulators and downloads the CSV', async () => {
    renderWithProviders(<ComplianceExportCard />);
    expect(screen.getByTestId('role-gate-hint')).toBeTruthy();
    cleanup();
    clearApiCache();

    // jsdom lacks createObjectURL — patch the real URL constructor in place.
    (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => 'blob:mock');
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
    previewRole('regulator', 'user-regulator');
    renderWithProviders(<ComplianceExportCard />);
    const button = await screen.findByRole('button', { name: 'Download CSV' });
    fireEvent.click(button);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/api/v1/livestock-compliance/export.csv')
      );
      expect(call).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText('downloaded')).toBeTruthy();
    });
  });

  it('shows the provenance badge for livestock-certified listings and nothing for crops', async () => {
    const { container: cropContainer } = render(<LivestockProvenanceBadge listing={CROP_LISTING} />);
    // Crop listing: no API call, no badge.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cropContainer.textContent).toBe('');

    renderWithProviders(<LivestockProvenanceBadge listing={LIVESTOCK_LISTING} />);
    await waitFor(() => {
      expect(screen.getByText(/ALTP certified/)).toBeTruthy();
    });
    const link = screen.getByRole('link', { name: /Livestock provenance/ });
    expect(link.getAttribute('href')).toBe('/livestock/trade#certified-listing-cert-1');
  });

  it('badge prefers the direct certifiedListingId link via the public provenance API (G18)', async () => {
    fetchMock.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/api/v1/livestock-trade/certified-listings/cert-link-9/provenance')) {
        return jsonResponse({
          data: {
            listingId: 'cert-link-9',
            certificationStatus: 'active',
            subjectType: 'animal',
            species: 'goat',
            breed: 'Red Sokoto',
            ownershipDepth: 3,
            state: 'Kaduna'
          }
        });
      }
      return jsonResponse({ error: { message: 'not found' } }, 404);
    });
    // No livestock crop term in the title — only the direct link can resolve.
    const linked: MarketplaceListing = {
      ...CROP_LISTING,
      id: 'listing-mkt-77',
      title: 'Breeding doe, vaccinated',
      crop: undefined,
      certifiedListingId: 'cert-link-9'
    };
    renderWithProviders(<LivestockProvenanceBadge listing={linked} />);
    await waitFor(() => {
      expect(screen.getByText(/ALTP certified · 3 transfers/)).toBeTruthy();
    });
    const link = screen.getByRole('link', { name: /Livestock provenance/ });
    expect(link.getAttribute('href')).toBe('/livestock/trade#certified-cert-link-9');
    // The legacy per-id fallback endpoint was NOT consulted.
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/v1/livestock-trade/listings/listing-mkt-77')
      )
    ).toBe(false);
  });

  it('badge stays absent when the linked certified listing is not public (draft/withdrawn 404)', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ error: { message: 'not found' } }, 404));
    const linked: MarketplaceListing = {
      ...CROP_LISTING,
      id: 'listing-mkt-78',
      certifiedListingId: 'cert-hidden-1'
    };
    const { container } = renderWithProviders(<LivestockProvenanceBadge listing={linked} />);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(container.textContent).toBe('');
  });

  it('renders the dashboard livestock summary for farmers with species counts', async () => {
    renderWithProviders(<LivestockSummaryCard />);
    await waitFor(() => {
      expect(screen.getByText('Livestock summary')).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText('1 cattle')).toBeTruthy();
    });
    // The due-vaccination endpoint reports one overdue item for the animal.
    expect(screen.getByLabelText('1 vaccinations due or overdue')).toBeTruthy();
    // Recall listing is regulator-only (403) → farmer sees the limited-visibility pill.
    expect(screen.getByLabelText('Open recalls are only visible to regulators')).toBeTruthy();
  });

  it('hides the dashboard livestock widget for non-farmer personas', async () => {
    previewRole('buyer', 'user-ngozi');
    renderWithProviders(<LivestockSummaryCard />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('Livestock summary')).toBeNull();
  });

  it('CertifiedListingsPanel composite has no axe violations', async () => {
    const { container } = renderWithProviders(<CertifiedListingsPanel />);
    await waitFor(() => {
      expect(container.textContent).toContain('listing-cert-1');
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('LiensConsole composite has no axe violations', async () => {
    previewRole('lender', 'user-lender');
    const { container } = renderWithProviders(<LiensConsole />);
    await waitFor(() => {
      expect(container.textContent).toContain('6-month input credit');
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
