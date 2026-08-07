import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import {
  BeneficiaryEnrolSection,
  FarmerVoucherSection,
  StubIdentityBadge,
  SubsidyProgrammeSection,
  SubsidyReconciliationSection,
  SupplierRedeemSection,
  VoucherAllocateSection
} from '@/components/input-vouchers-live';

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

const PROGRAMME = {
  id: 'prog-1',
  name: '2026 wet-season fertiliser',
  sponsor: 'FMARD (STUB demo)',
  status: 'DRAFT',
  perFarmerCapKobo: 500_000,
  budgetKobo: 2_000_000,
  eligibleStates: [],
  eligibleCrops: [],
  liabilityAccountCode: 'programme:prog-1:liability',
  createdBy: 'user-admin',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z'
};

const ACTIVE_PROGRAMME = { ...PROGRAMME, status: 'ACTIVE' };

const BENEFICIARY = {
  id: 'ben-1',
  programmeId: 'prog-1',
  farmerId: 'user-farmer',
  ninHash: 'a'.repeat(64),
  ninMask: '********901',
  verificationBasis: 'stub',
  nameMatchScore: 88,
  state: 'Kano',
  primaryCrop: 'maize',
  verifiedAt: '2026-03-02T00:00:00.000Z',
  createdAt: '2026-03-02T00:00:00.000Z'
};

const VOUCHER = {
  id: 'ivc-1',
  programmeId: 'prog-1',
  beneficiaryId: 'ben-1',
  farmerId: 'user-farmer',
  amountKobo: 200_000,
  status: 'ISSUED',
  idempotencyKey: 'alloc-1',
  expiresAt: '2026-06-01T00:00:00.000Z',
  distributedAt: '2026-03-03T00:00:00.000Z',
  createdAt: '2026-03-03T00:00:00.000Z'
};

const RECONCILIATION = {
  programmeId: 'prog-1',
  budgetKobo: 2_000_000,
  totals: {
    vouchersIssued: 3,
    allocatedKobo: 600_000,
    outstandingCount: 1,
    outstandingKobo: 100_000,
    redeemedCount: 1,
    redeemedKobo: 200_000,
    expiredCount: 0,
    expiredKobo: 0,
    voidedCount: 1,
    voidedKobo: 300_000,
    beneficiariesVerified: 2
  },
  byState: [
    { state: 'Kaduna', vouchersIssued: 1, outstandingKobo: 100_000, redeemedKobo: 0 },
    { state: 'Kano', vouchersIssued: 2, outstandingKobo: 0, redeemedKobo: 200_000 }
  ],
  ledger: {
    liabilityAccountCode: 'programme:prog-1:liability',
    liabilityKobo: 1_500_000,
    expectedLiabilityKobo: 1_500_000,
    discrepancyKobo: 0
  },
  generatedAt: '2026-03-04T00:00:00.000Z'
};

/** Routes the stubbed fetch by API path suffix; unmatched paths 404. */
function stubApi(fetchMock: ReturnType<typeof vi.fn>, routes: Record<string, unknown>) {
  fetchMock.mockImplementation((url: string) => {
    const path = new URL(String(url)).pathname;
    for (const [suffix, body] of Object.entries(routes)) {
      if (path.endsWith(suffix)) {
        return jsonResponse(body);
      }
    }
    return jsonResponse({ error: 'not found' }, 404);
  });
}

describe('Input vouchers — STUB honesty (wave-nin-vouchers)', () => {
  beforeEach(() => {
    clearApiCache();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => cleanup());

  it('the STUB identity badge labels the check honestly', () => {
    renderWithProviders(<StubIdentityBadge />);
    expect(screen.getByText('STUB identity check')).toBeTruthy();
    expect(screen.getByText(/not a live NIMC lookup/)).toBeTruthy();
  });
});

describe('Programme administration', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    window.localStorage.clear();
    window.sessionStorage.clear();
    previewRole('admin', 'user-admin');
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => cleanup());

  it('lists programmes with whole-naira budget and status badges', async () => {
    stubApi(fetchMock, { '/input-vouchers/programmes': { data: [PROGRAMME] } });
    renderWithProviders(<SubsidyProgrammeSection />);
    await waitFor(() => expect(screen.getByTestId('programme-prog-1')).toBeTruthy());
    expect(screen.getByText('₦5,000')).toBeTruthy();
    expect(screen.getByText('₦20,000')).toBeTruthy();
    expect(screen.getByText('DRAFT')).toBeTruthy();
    expect(screen.getByText('STUB identity check')).toBeTruthy();
  });

  it('creates a programme and shows the DRAFT notice', async () => {
    stubApi(fetchMock, { '/input-vouchers/programmes': { data: [PROGRAMME] } });
    renderWithProviders(<SubsidyProgrammeSection />);
    await waitFor(() => expect(screen.getByTestId('programme-prog-1')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Programme name'), { target: { value: '2026 dry-season rice' } });
    fireEvent.change(screen.getByLabelText('Sponsor'), { target: { value: 'State ministry' } });
    fireEvent.change(screen.getByLabelText('Cap per farmer (₦)'), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText('Budget (₦)'), { target: { value: '20000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create programme' }));
    await waitFor(() =>
      expect(screen.getByText(/Programme created as DRAFT/)).toBeTruthy()
    );
    const createCall = fetchMock.mock.calls.find((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method === 'POST' && String(call[0]).includes('/input-vouchers/programmes');
    });
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String((createCall?.[1] as RequestInit).body))).toMatchObject({
      name: '2026 dry-season rice',
      perFarmerCapKobo: 500_000,
      budgetKobo: 2_000_000
    });
  });

  it('shows the programme empty state', async () => {
    stubApi(fetchMock, { '/input-vouchers/programmes': { data: [] } });
    renderWithProviders(<SubsidyProgrammeSection />);
    await waitFor(() => expect(screen.getByText('No programmes yet.')).toBeTruthy());
  });
});

describe('Beneficiary enrolment', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    window.localStorage.clear();
    window.sessionStorage.clear();
    previewRole('admin', 'user-admin');
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => cleanup());

  it('enrols a farmer and shows the NIN mask + stub basis, never the plaintext NIN', async () => {
    stubApi(fetchMock, {
      '/input-vouchers/programmes': { data: [ACTIVE_PROGRAMME] },
      '/input-vouchers/programmes/prog-1/beneficiaries': { data: BENEFICIARY }
    });
    renderWithProviders(<BeneficiaryEnrolSection />);
    await waitFor(() => expect(screen.getByLabelText('Programme')).toBeTruthy());
    // Wait for the programmes query to render the option: firing change on a
    // controlled <select> before the option exists resets the value to ''
    // (jsdom mirrors the browser), which intermittently blocked the flow.
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /2026 wet-season fertiliser/ })).toBeTruthy()
    );
    fireEvent.change(screen.getByLabelText('Programme'), { target: { value: 'prog-1' } });
    fireEvent.change(screen.getByLabelText('Farmer ID'), { target: { value: 'user-farmer' } });
    fireEvent.change(screen.getByLabelText('NIN (11 digits)'), { target: { value: '12345678901' } });
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Farmer Femi' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Kano' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and enrol' }));
    await waitFor(() => expect(screen.getByTestId('beneficiary-enrolled')).toBeTruthy());
    const notice = screen.getByTestId('beneficiary-enrolled');
    expect(notice.textContent).toContain('********901');
    expect(notice.textContent).toContain('stub');
    expect(notice.textContent).not.toContain('12345678901');
  });
});

describe('Allocation + farmer vouchers', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => cleanup());

  it('lists programme vouchers for the admin with a distribute action', async () => {
    previewRole('admin', 'user-admin');
    stubApi(fetchMock, {
      '/input-vouchers/programmes': { data: [ACTIVE_PROGRAMME] },
      '/input-vouchers/programmes/prog-1/vouchers': { data: [{ ...VOUCHER, distributedAt: undefined }] }
    });
    renderWithProviders(<VoucherAllocateSection />);
    await waitFor(() => expect(screen.getByLabelText('Programme')).toBeTruthy());
    // Wait for the programmes query to render the option: firing change on a
    // controlled <select> before the option exists resets the value to ''
    // (jsdom mirrors the browser), which intermittently blocked the flow.
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /2026 wet-season fertiliser/ })).toBeTruthy()
    );
    fireEvent.change(screen.getByLabelText('Programme'), { target: { value: 'prog-1' } });
    await waitFor(() => expect(screen.getByTestId('voucher-ivc-1')).toBeTruthy());
    expect(screen.getByTestId('voucher-ivc-1').textContent).toContain('₦2,000');
    expect(screen.getByRole('button', { name: 'Distribute' })).toBeTruthy();
  });

  it('renders the farmer voucher list with amounts and status', async () => {
    previewRole('farmer', 'user-farmer');
    stubApi(fetchMock, { '/input-vouchers/farmers/me/vouchers': { data: [VOUCHER] } });
    renderWithProviders(<FarmerVoucherSection />);
    await waitFor(() => expect(screen.getByTestId('my-voucher-ivc-1')).toBeTruthy());
    expect(screen.getByTestId('my-voucher-ivc-1').textContent).toContain('₦2,000');
    expect(screen.getByText('ISSUED')).toBeTruthy();
    expect(screen.getByText('Ready to redeem')).toBeTruthy();
  });

  it('shows the farmer empty state', async () => {
    previewRole('farmer', 'user-farmer');
    stubApi(fetchMock, { '/input-vouchers/farmers/me/vouchers': { data: [] } });
    renderWithProviders(<FarmerVoucherSection />);
    await waitFor(() => expect(screen.getByText('You have no vouchers yet.')).toBeTruthy());
  });
});

describe('Supplier redemption + reconciliation', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => cleanup());

  it('redeems a voucher against an invoice reference', async () => {
    previewRole('supplier', 'user-supplier');
    stubApi(fetchMock, {
      '/input-vouchers/vouchers/ivc-1/redeem': {
        data: {
          voucher: { ...VOUCHER, status: 'REDEEMED' },
          redemption: { id: 'ired-1', invoiceRef: 'INV-1001' }
        }
      }
    });
    renderWithProviders(<SupplierRedeemSection />);
    fireEvent.change(screen.getByLabelText('Voucher code'), { target: { value: 'ivc-1' } });
    fireEvent.change(screen.getByLabelText('Invoice reference'), { target: { value: 'INV-1001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Redeem' }));
    await waitFor(() => expect(screen.getByText(/Voucher redeemed against the invoice/)).toBeTruthy());
    const call = fetchMock.mock.calls.find((entry) => String(entry[0]).includes('/redeem'));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ invoiceRef: 'INV-1001' });
  });

  it('renders the reconciliation with the ledger tie in whole naira', async () => {
    previewRole('regulator', 'user-regulator');
    stubApi(fetchMock, {
      '/input-vouchers/programmes': { data: [ACTIVE_PROGRAMME] },
      '/input-vouchers/programmes/prog-1/reconciliation': { data: RECONCILIATION }
    });
    renderWithProviders(<SubsidyReconciliationSection />);
    await waitFor(() => expect(screen.getByLabelText('Programme')).toBeTruthy());
    // Wait for the programmes query to render the option: firing change on a
    // controlled <select> before the option exists resets the value to ''
    // (jsdom mirrors the browser), which intermittently blocked the flow.
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /2026 wet-season fertiliser/ })).toBeTruthy()
    );
    fireEvent.change(screen.getByLabelText('Programme'), { target: { value: 'prog-1' } });
    await waitFor(() => expect(screen.getByTestId('reconciliation-report')).toBeTruthy());
    expect(screen.getByTestId('report-budget').textContent).toBe('₦20,000');
    expect(screen.getByTestId('report-redeemed').textContent).toBe('₦2,000');
    expect(screen.getByTestId('report-tie').textContent).toContain('₦0');
    expect(screen.getByText('Kano')).toBeTruthy();
    expect(screen.getByText('Kaduna')).toBeTruthy();
  });
});
