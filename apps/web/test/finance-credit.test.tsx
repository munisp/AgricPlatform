import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { CreditScoreSection, LenderMatchSection, MyLoansSection } from '@/components/finance-credit';

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

const SCORE = {
  userId: 'user-adamu',
  version: 'credit-score/v1',
  score: 64,
  components: {
    base: 10,
    training: 24,
    trade_history: 15,
    repayment_history: 14,
    documentation: 5,
    penalties: 4
  },
  computedAt: '2026-02-01T00:00:00.000Z'
};

const LENDER = {
  id: 'lender-1',
  name: 'Sterling Agric Credit',
  product: 'Seasonal input loan',
  minTicketKobo: 50_000_00,
  maxTicketKobo: 2_000_000_00,
  minScore: 40,
  criteria: ['Active farmer profile'],
  isActive: true
};

const LOAN = {
  id: 'loan-1',
  applicantId: 'user-adamu',
  lenderId: 'lender-1',
  amountKobo: 250_000_00,
  termMonths: 2,
  annualRateBps: 1000,
  status: 'repaying',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-05T00:00:00.000Z'
};

const SCHEDULE = [
  {
    id: 'inst-1',
    loanId: 'loan-1',
    sequence: 1,
    dueDate: '2026-03-01',
    principalKobo: 123_958_00 / 1,
    interestKobo: 2_083_00,
    totalKobo: 126_041_00,
    status: 'pending'
  },
  {
    id: 'inst-2',
    loanId: 'loan-1',
    sequence: 2,
    dueDate: '2026-04-01',
    principalKobo: 126_042_00,
    interestKobo: 2_082_00,
    totalKobo: 128_124_00,
    status: 'paid',
    paidAt: '2026-04-01T10:00:00.000Z'
  }
];

function router(url: string, init?: RequestInit) {
  const path = new URL(url).pathname;
  if (path.endsWith('/api/v1/finance/credit-score/user-adamu')) {
    return jsonResponse({ data: SCORE });
  }
  if (path.endsWith('/api/v1/finance/lenders/match/user-adamu')) {
    return jsonResponse({
      data: [
        {
          lender: LENDER,
          eligible: true,
          matchScore: 24,
          reason: 'Score 64 meets the 40+ requirement'
        }
      ]
    });
  }
  if (path.endsWith('/api/v1/finance/loans') && init?.method === 'POST') {
    return jsonResponse({ data: { ...LOAN, id: 'loan-new', status: 'draft' } });
  }
  if (path.endsWith('/api/v1/finance/loans') && (!init?.method || init.method === 'GET')) {
    return jsonResponse({ data: [LOAN] });
  }
  if (path.endsWith('/api/v1/finance/loans/loan-1/schedule')) {
    return jsonResponse({ data: SCHEDULE });
  }
  if (path.includes('/installments/1/pay') && init?.method === 'POST') {
    return jsonResponse({ data: { ...SCHEDULE[0], status: 'paid' } });
  }
  return jsonResponse({ data: null });
}

describe('Finance depth', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(router);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders the credit score with factor breakdown', async () => {
    renderWithProviders(<CreditScoreSection />);
    await waitFor(() => {
      expect(screen.getByLabelText('Credit score 64 out of 100')).toBeTruthy();
    });
    expect(screen.getByText('Trade history')).toBeTruthy();
    expect(screen.getByText('Penalties')).toBeTruthy();
    expect(screen.getByText('−4')).toBeTruthy();
  });

  it('renders lender matches with eligibility', async () => {
    renderWithProviders(<LenderMatchSection />);
    await waitFor(() => {
      // Match row + loan-form select option both show the lender name.
      expect(
        screen.getAllByText('Sterling Agric Credit — Seasonal input loan').length
      ).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText('eligible')).toBeTruthy();
    expect(screen.getByText(/Score 64 meets the 40\+ requirement/)).toBeTruthy();
  });

  it('submits a loan application in integer kobo', async () => {
    renderWithProviders(<LenderMatchSection />);
    await waitFor(() => {
      expect(screen.getByLabelText('Lender')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Lender'), { target: { value: 'lender-1' } });
    fireEvent.change(screen.getByLabelText('Amount (₦)'), { target: { value: '250000' } });
    fireEvent.change(screen.getByLabelText('Term (months)'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save application' }));

    await waitFor(() => {
      expect(screen.getByText(/Application saved/i)).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(([url, init]) => {
      const parsed = new URL(String(url));
      return (
        parsed.pathname.endsWith('/api/v1/finance/loans') &&
        (init as RequestInit)?.method === 'POST'
      );
    });
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.amountKobo).toBe(25_000_000);
    expect(body.termMonths).toBe(6);
    expect(body.applicantId).toBe('user-adamu');
  });

  it('shows the repayment schedule with per-installment status and mark-paid', async () => {
    renderWithProviders(<MyLoansSection />);
    await waitFor(() => {
      expect(screen.getByText('repaying')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Repayment schedule' }));

    await waitFor(() => {
      expect(screen.getByText('pending')).toBeTruthy();
    });
    expect(screen.getByText('paid')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Mark installment 1 as paid' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, init]) =>
        String(url).includes('/api/v1/finance/loans/loan-1/installments/1/pay') &&
        (init as RequestInit)?.method === 'POST'
      );
      expect(call).toBeTruthy();
    });
  });
});
