import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import {
  AgentCommissionSection,
  AgentFloatSection,
  AgentTopUpQueueSection,
  AgentTopUpSection,
  AgentTransactionLogSection,
  AgentVoucherRedeemSection,
  AgentVoucherSection
} from '@/components/agent-banking-live';

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

const AGENT = {
  id: 'agent-1',
  userId: 'user-agent',
  organisation: 'Kano Farmers Cooperative',
  status: 'ACTIVE',
  floatAccountCode: 'agent:agent-1:float',
  commissionAccountCode: 'agent:agent-1:commission_payable',
  dailyLimitKobo: 25_000_000,
  lowFloatThresholdKobo: 2_000_000,
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z'
};

const FLOAT = {
  agentId: 'agent-1',
  floatAccountCode: 'agent:agent-1:float',
  balanceKobo: 15_200_000,
  lowFloatThresholdKobo: 2_000_000,
  lowFloat: false
};

const TOPUP = {
  id: 'topup-1',
  agentId: 'agent-1',
  amountKobo: 5_000_000,
  status: 'REQUESTED',
  requestedBy: 'user-agent',
  createdAt: '2026-02-02T00:00:00.000Z'
};

const TX = {
  id: 'agtx-1',
  agentId: 'agent-1',
  farmerId: 'user-farmer',
  type: 'cash_in',
  amountKobo: 500_000,
  commissionKobo: 2_500,
  idempotencyKey: 'ci-1',
  ledgerEntryId: 'entry-1',
  createdAt: '2026-02-03T00:00:00.000Z'
};

const VOUCHER = {
  id: 'voucher-1',
  agentId: 'agent-1',
  farmerId: 'user-farmer',
  amountKobo: 250_000,
  expiresAt: '2026-02-06T00:00:00.000Z',
  nonce: 'nonce-1',
  signature: 'a'.repeat(64),
  status: 'ISSUED',
  createdAt: '2026-02-03T00:00:00.000Z'
};

const STATEMENT = {
  agentId: 'agent-1',
  month: '2026-02',
  rows: [{ type: 'cash_in', count: 2, volumeKobo: 1_000_000, commissionKobo: 5_000 }],
  totalCommissionKobo: 5_000,
  commissionPayableKobo: 5_000
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

describe('Agent float dashboard', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    window.localStorage.clear();
    window.sessionStorage.clear();
    previewRole('agent', 'user-agent');
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => cleanup());

  it('renders the float balance and threshold bar', async () => {
    stubApi(fetchMock, {
      '/agent-banking/agents/me': { data: AGENT },
      '/agent-banking/agents/agent-1/float': { data: FLOAT }
    });
    renderWithProviders(<AgentFloatSection />);
    await waitFor(() => expect(screen.getByTestId('float-balance').textContent).toContain('152,000'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the low-float alert when the ledger balance is below the threshold', async () => {
    stubApi(fetchMock, {
      '/agent-banking/agents/me': { data: AGENT },
      '/agent-banking/agents/agent-1/float': { data: { ...FLOAT, balanceKobo: 500_000, lowFloat: true } }
    });
    renderWithProviders(<AgentFloatSection />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Low float'));
  });

  it('shows the not-agent empty state when the profile lookup fails', async () => {
    stubApi(fetchMock, {});
    renderWithProviders(<AgentFloatSection />);
    await waitFor(() => expect(screen.getByText('No agent registration')).toBeTruthy());
  });
});

describe('Top-up request and supervisor queue', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    window.localStorage.clear();
    window.sessionStorage.clear();
    previewRole('agent', 'user-agent');
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => cleanup());

  it('submits a top-up request and lists it', async () => {
    stubApi(fetchMock, {
      '/agent-banking/agents/me': { data: AGENT },
      '/agent-banking/agents/agent-1/top-ups': { data: [TOPUP] }
    });
    renderWithProviders(<AgentTopUpSection />);
    await waitFor(() => expect(screen.getByText(/50,000/)).toBeTruthy());
    expect(screen.getByText('REQUESTED')).toBeTruthy();
  });

  it('renders the supervisor approval queue with actions', async () => {
    previewRole('admin', 'user-admin');
    stubApi(fetchMock, { '/agent-banking/top-ups': { data: [TOPUP] } });
    renderWithProviders(<AgentTopUpQueueSection />);
    await waitFor(() => expect(screen.getByTestId('topup-topup-1')).toBeTruthy());
    expect(screen.getByText('Approve')).toBeTruthy();
    expect(screen.getByText('Settle')).toBeTruthy();
    expect(screen.getByText('Reject')).toBeTruthy();
  });

  it('shows the queue empty state', async () => {
    previewRole('admin', 'user-admin');
    stubApi(fetchMock, { '/agent-banking/top-ups': { data: [] } });
    renderWithProviders(<AgentTopUpQueueSection />);
    await waitFor(() => expect(screen.getByText('No top-ups waiting for review.')).toBeTruthy());
  });
});

describe('Transaction log, vouchers and commissions', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    window.localStorage.clear();
    window.sessionStorage.clear();
    previewRole('agent', 'user-agent');
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => cleanup());

  it('renders the transaction log with a type filter', async () => {
    stubApi(fetchMock, {
      '/agent-banking/agents/me': { data: AGENT },
      '/agent-banking/agents/agent-1/transactions': { data: [TX] }
    });
    renderWithProviders(<AgentTransactionLogSection />);
    await waitFor(() => expect(screen.getByText('cash_in')).toBeTruthy());
    const filter = screen.getByLabelText('Transaction log') as HTMLSelectElement;
    fireEvent.change(filter, { target: { value: 'cash_out' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('issues a voucher and surfaces the signature', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? 'GET';
      if (path.endsWith('/agent-banking/agents/me')) return jsonResponse({ data: AGENT });
      if (path.endsWith('/agent-banking/agents/agent-1/vouchers') && method === 'POST') {
        return jsonResponse({ data: VOUCHER });
      }
      if (path.endsWith('/agent-banking/agents/agent-1/vouchers')) {
        return jsonResponse({ data: [] });
      }
      return jsonResponse({ error: 'not found' }, 404);
    });
    renderWithProviders(<AgentVoucherSection />);
    await waitFor(() => expect(screen.getByText('No vouchers yet.')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Farmer ID'), { target: { value: 'user-farmer' } });
    fireEvent.change(screen.getByLabelText('Amount (₦)'), { target: { value: '2500' } });
    fireEvent.click(screen.getByText('Issue voucher'));
    await waitFor(() => expect(screen.getByTestId('voucher-issued').textContent).toContain('voucher-1'));
  });

  it('redeems a voucher and shows the confirmation', async () => {
    stubApi(fetchMock, {
      '/agent-banking/vouchers/voucher-1/redeem': {
        data: { voucher: { ...VOUCHER, status: 'REDEEMED' }, transaction: TX }
      }
    });
    renderWithProviders(<AgentVoucherRedeemSection />);
    fireEvent.change(screen.getByLabelText('Voucher code'), { target: { value: 'voucher-1' } });
    fireEvent.change(screen.getByLabelText('Signature (from the voucher)'), {
      target: { value: 'a'.repeat(64) }
    });
    fireEvent.click(screen.getByText('Redeem'));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Voucher redeemed')
    );
  });

  it('shows the redeem error when the API rejects', async () => {
    stubApi(fetchMock, {});
    renderWithProviders(<AgentVoucherRedeemSection />);
    fireEvent.change(screen.getByLabelText('Voucher code'), { target: { value: 'voucher-9' } });
    fireEvent.click(screen.getByText('Redeem'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });

  it('renders the monthly commission statement', async () => {
    stubApi(fetchMock, {
      '/agent-banking/agents/me': { data: AGENT },
      '/agent-banking/agents/agent-1/commissions': { data: STATEMENT }
    });
    renderWithProviders(<AgentCommissionSection />);
    // House format: whole naira (shared formatNaira, maximumFractionDigits: 0).
    await waitFor(() =>
      expect(screen.getByTestId('commission-total').textContent).toContain('Total accrued: ₦50')
    );
    expect(screen.getByText('cash_in')).toBeTruthy();
  });
});
