import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { AppProvider, useAppState } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { getDraftsDb } from '@/lib/drafts';
import type { QueuedSubmission } from '@/lib/offline-queue';

expect.extend(toHaveNoViolations);

// jsdom does no layout and the stylesheet is not loaded — color contrast is
// covered by test/contrast.test.ts against the CSS source.
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };
import {
  CreditApplySection,
  CreditGroupsSection,
  CreditProductsSection,
  CreditSavingsSection,
  CreditScorePreviewSection,
  MyCreditLoansSection
} from '@/components/credit-live';
import {
  CreditGroupLoansSection,
  CreditPortfolioSection,
  CreditReviewQueueSection
} from '@/components/admin-credit-live';

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

const PRODUCT = {
  id: 'cprd-seasonal',
  name: 'Seasonal input loan',
  minPrincipalKobo: 100_000,
  maxPrincipalKobo: 5_000_000,
  interestBpsAnnual: 1200,
  termDays: 180,
  groupLending: false,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const GROUP_PRODUCT = { ...PRODUCT, id: 'cprd-vsla', name: 'VSLA group loan', groupLending: true };

const LOAN = {
  id: 'cloan-1',
  applicantUserId: 'user-adamu',
  productId: 'cprd-seasonal',
  principalKobo: 1_000_000,
  status: 'repaying',
  creditScore: 640,
  scoreFactors: {
    repaymentHistory: 150,
    profileCompleteness: 160,
    transactionVolume: 130,
    guarantorStrength: 100,
    groupStanding: 100
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-05T00:00:00.000Z'
};

const SCORING_LOAN = { ...LOAN, id: 'cloan-2', status: 'scoring' };

const GROUP_LOAN = { ...LOAN, id: 'cloan-3', groupId: 'cgrp-1' };

const SCHEDULE = [
  {
    id: 'crp-1',
    loanId: 'cloan-1',
    sequence: 1,
    dueAt: '2026-03-01T00:00:00.000Z',
    amountKobo: 176_529,
    status: 'pending'
  },
  {
    id: 'crp-2',
    loanId: 'cloan-1',
    sequence: 2,
    dueAt: '2026-04-01T00:00:00.000Z',
    amountKobo: 176_533,
    status: 'paid',
    paidAt: '2026-04-01T10:00:00.000Z',
    paidAmountKobo: 176_533
  }
];

const GROUP = {
  group: { id: 'cgrp-1', name: 'Kano VSLA', createdBy: 'user-adamu', createdAt: '2026-01-01T00:00:00.000Z' },
  members: [
    { groupId: 'cgrp-1', userId: 'user-adamu', role: 'leader', joinedAt: '2026-01-01T00:00:00.000Z' },
    { groupId: 'cgrp-1', userId: 'user-aisha', role: 'member', joinedAt: '2026-01-02T00:00:00.000Z' }
  ]
};

const ACCOUNT = {
  id: 'csav-1',
  userId: 'user-adamu',
  balanceKobo: 250_000,
  updatedAt: '2026-02-01T00:00:00.000Z'
};

const ASSESSMENT = {
  userId: 'user-adamu',
  score: 640,
  factors: {
    repaymentHistory: 150,
    profileCompleteness: 160,
    transactionVolume: 130,
    guarantorStrength: 100,
    groupStanding: 100
  },
  computedAt: '2026-02-01T00:00:00.000Z'
};

const PORTFOLIO = {
  generatedAt: '2026-02-10T00:00:00.000Z',
  totalLoans: 3,
  activeLoans: 2,
  defaultedLoans: 1,
  outstandingKobo: 700_000,
  defaultedKobo: 500_000,
  par30Kobo: 700_000,
  par60Kobo: 300_000,
  par90Kobo: 300_000,
  par30Bps: 10_000,
  par60Bps: 4_286,
  par90Bps: 4_286
};

function router(url: string, init?: RequestInit) {
  const path = new URL(url).pathname;
  if (path.endsWith('/api/v1/credit/products')) {
    return jsonResponse({ data: [PRODUCT, GROUP_PRODUCT] });
  }
  if (path.endsWith('/api/v1/credit/applications') && init?.method === 'POST') {
    return jsonResponse({ data: { ...LOAN, id: 'cloan-new', status: 'draft' } });
  }
  if (path.endsWith('/api/v1/credit/applications/cloan-new/submit')) {
    return jsonResponse({ data: { ...LOAN, id: 'cloan-new', status: 'submitted' } });
  }
  if (path.endsWith('/api/v1/credit/applications') || path.endsWith('/api/v1/credit/applications?')) {
    return jsonResponse({ data: [LOAN, SCORING_LOAN, GROUP_LOAN] });
  }
  if (path.endsWith('/api/v1/credit/applications/cloan-1/schedule')) {
    return jsonResponse({ data: SCHEDULE });
  }
  if (path.includes('/repayments/1/pay')) {
    return jsonResponse({ data: { ...SCHEDULE[0], status: 'paid' } });
  }
  if (path.endsWith('/api/v1/credit/applications/cloan-2/approve')) {
    return jsonResponse({ data: { ...SCORING_LOAN, status: 'approved' } });
  }
  if (path.endsWith('/api/v1/credit/applications/cloan-3/guarantors')) {
    return jsonResponse({
      data: [
        { id: 'cgar-1', loanId: 'cloan-3', guarantorUserId: 'user-aisha', status: 'accepted' },
        { id: 'cgar-2', loanId: 'cloan-3', guarantorUserId: 'user-bala', status: 'accepted' }
      ]
    });
  }
  if (path.endsWith('/api/v1/credit/groups/mine')) {
    return jsonResponse({ data: [GROUP] });
  }
  if (path.endsWith('/api/v1/credit/groups') && init?.method === 'POST') {
    return jsonResponse({ data: GROUP });
  }
  if (path.endsWith('/api/v1/credit/savings/accounts/mine/transactions')) {
    return jsonResponse({ data: [] });
  }
  if (path.endsWith('/api/v1/credit/savings/accounts/mine/deposits')) {
    return jsonResponse({
      data: {
        account: { ...ACCOUNT, balanceKobo: 350_000 },
        transaction: {
          id: 'ctxn-1',
          accountId: 'csav-1',
          direction: 'deposit',
          amountKobo: 100_000,
          balanceAfterKobo: 350_000,
          ref: 'ref-1',
          createdAt: '2026-02-10T00:00:00.000Z'
        },
        replay: false
      }
    });
  }
  if (path.endsWith('/api/v1/credit/savings/accounts/mine')) {
    return jsonResponse({ data: ACCOUNT });
  }
  if (path.endsWith('/api/v1/credit/score/user-adamu')) {
    return jsonResponse({ data: ASSESSMENT });
  }
  if (path.endsWith('/api/v1/credit/portfolio')) {
    return jsonResponse({ data: PORTFOLIO });
  }
  return jsonResponse({ data: null });
}

function readStoredQueue(): QueuedSubmission[] {
  return JSON.parse(window.localStorage.getItem('agric.queue') ?? '[]') as QueuedSubmission[];
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });
}

/** Test probe: flushes the offline queue from inside AppProvider. */
function FlushProbe() {
  const { syncQueue } = useAppState();
  return (
    <button type="button" data-testid="flush-queue" onClick={() => void syncQueue()}>
      flush
    </button>
  );
}

describe('Credit pages (farmer)', () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(router);
    setOnline(true);
    const db = getDraftsDb();
    if (db) await db.drafts.clear();
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders loan products with ranges and the group badge', async () => {
    renderWithProviders(<CreditProductsSection />);
    await waitFor(() => {
      expect(screen.getByText('Seasonal input loan')).toBeTruthy();
    });
    expect(screen.getByText('VSLA group loan')).toBeTruthy();
    expect(screen.getByText('Group loan')).toBeTruthy();
  });

  it('walks the apply wizard: draft then submit, with a success notice', async () => {
    renderWithProviders(<CreditApplySection />);
    await waitFor(() => {
      expect(screen.getByText('Seasonal input loan')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Choose a product'), {
      target: { value: 'cprd-seasonal' }
    });
    fireEvent.change(screen.getByLabelText('Amount (naira)'), { target: { value: '10000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('cloan-new');
    });
    const posts = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
    );
    expect(posts.length).toBe(2); // create draft + submit
  });

  it('lists my loans with schedule and a pay button that records payment', async () => {
    renderWithProviders(<MyCreditLoansSection />);
    await waitFor(() => {
      expect(screen.getAllByText('repaying').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Repayment schedule' })[0]!);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pay installment 1' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pay installment 1' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('/repayments/1/pay'))
      ).toBe(true);
    });
  });

  it('renders my groups with the leader badge and creates a group', async () => {
    renderWithProviders(<CreditGroupsSection />);
    await waitFor(() => {
      expect(screen.getByText('Kano VSLA')).toBeTruthy();
    });
    expect(screen.getByText(/Leader/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Zaria VSLA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/api/v1/credit/groups') &&
            (init as RequestInit | undefined)?.method === 'POST'
        )
      ).toBe(true);
    });
  });

  it('shows the savings balance and deposits with a generated ref', async () => {
    renderWithProviders(<CreditSavingsSection />);
    await waitFor(() => {
      expect(screen.getByLabelText('Savings balance 250000 kobo')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Deposit (naira)'), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deposit' }));
    await waitFor(() => {
      const deposit = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith('/accounts/mine/deposits')
      );
      expect(deposit).toBeTruthy();
      const body = JSON.parse(String((deposit![1] as RequestInit).body)) as {
        amountKobo: number;
        ref: string;
      };
      expect(body.amountKobo).toBe(100_000);
      expect(body.ref.length).toBeGreaterThan(8);
    });
  });

  it('renders the score preview with the five factor labels', async () => {
    renderWithProviders(<CreditScorePreviewSection />);
    await waitFor(() => {
      expect(screen.getByLabelText('Credit score 640 out of 1000')).toBeTruthy();
    });
    expect(screen.getByText('Repayment history')).toBeTruthy();
    expect(screen.getByText('Group standing')).toBeTruthy();
  });

  it('queues the application offline and replays draft → submit chained by the returned id', async () => {
    setOnline(false);
    renderWithProviders(
      <>
        <CreditApplySection />
        <FlushProbe />
      </>
    );
    await waitFor(() => {
      expect(screen.getByText('Seasonal input loan')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Choose a product'), {
      target: { value: 'cprd-seasonal' }
    });
    fireEvent.change(screen.getByLabelText('Amount (naira)'), { target: { value: '10000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));

    // Nothing was sent; one compound queue item holds both steps.
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('saved on this device');
    });
    const posts = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
    );
    expect(posts).toHaveLength(0);
    const queued = readStoredQueue();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.kind).toBe('credit.loan.application');
    expect(queued[0]!.path).toBe('/credit/applications');
    expect(queued[0]!.chain).toEqual([
      { method: 'POST', path: '/credit/applications/{id}/submit' }
    ]);

    // Reconnect and flush: the draft replays first, then submit runs against
    // the id the draft replay returned (cloan-new) — a chained compound replay.
    setOnline(true);
    fireEvent.click(screen.getByTestId('flush-queue'));
    await waitFor(() => {
      const sent = fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
      );
      expect(sent).toHaveLength(2);
    });
    const sent = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
    );
    expect(String(sent[0]![0])).toMatch(/\/api\/v1\/credit\/applications$/);
    expect(String(sent[1]![0])).toContain('/api/v1/credit/applications/cloan-new/submit');
    await waitFor(() => {
      expect(readStoredQueue()[0]!.status).toBe('sent');
    });
  });

  it('keeps the application draft offline-safe across a remount (draft persistence)', async () => {
    setOnline(true);
    const first = renderWithProviders(<CreditApplySection />);
    await waitFor(() => {
      expect(screen.getByText('Seasonal input loan')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Choose a product'), {
      target: { value: 'cprd-seasonal' }
    });
    fireEvent.change(screen.getByLabelText('Amount (naira)'), { target: { value: '10000' } });
    await waitFor(
      async () => {
        const record = await getDraftsDb()?.drafts.get('credit-apply');
        expect(record?.data).toMatchObject({ productId: 'cprd-seasonal', amountNaira: '10000' });
      },
      { timeout: 3000 }
    );
    first.unmount();

    renderWithProviders(<CreditApplySection />);
    await waitFor(() => {
      expect((screen.getByLabelText('Amount (naira)') as HTMLInputElement).value).toBe('10000');
    });
    expect((screen.getByLabelText('Choose a product') as HTMLSelectElement).value).toBe(
      'cprd-seasonal'
    );
  });

  it('clears the application draft after a successful submit', async () => {
    renderWithProviders(<CreditApplySection />);
    await waitFor(() => {
      expect(screen.getByText('Seasonal input loan')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Choose a product'), {
      target: { value: 'cprd-seasonal' }
    });
    fireEvent.change(screen.getByLabelText('Amount (naira)'), { target: { value: '10000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit application' }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('cloan-new');
    });
    await waitFor(async () => {
      const record = await getDraftsDb()?.drafts.get('credit-apply');
      const data = record?.data as { amountNaira?: string } | undefined;
      expect(record === undefined || data?.amountNaira === '').toBe(true);
    });
    expect((screen.getByLabelText('Amount (naira)') as HTMLInputElement).value).toBe('');
  });

  it('has no accessibility violations (apply wizard + products composite)', async () => {
    const { container } = renderWithProviders(
      <>
        <CreditProductsSection />
        <CreditApplySection />
      </>
    );
    await waitFor(() => {
      expect(screen.getAllByText('Seasonal input loan').length).toBeGreaterThan(0);
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('Credit pages (admin)', () => {
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

  it('renders the PAR cards with ratios and outstanding totals', async () => {
    renderWithProviders(<CreditPortfolioSection />);
    await waitFor(() => {
      expect(screen.getByLabelText('PAR 30 100.0%')).toBeTruthy();
    });
    expect(screen.getByLabelText('PAR 60 42.9%')).toBeTruthy();
    expect(screen.getByText('Outstanding')).toBeTruthy();
  });

  it('renders the review queue with score breakdowns and approve action', async () => {
    renderWithProviders(<CreditReviewQueueSection />);
    await waitFor(() => {
      expect(screen.getByText('scoring')).toBeTruthy();
    });
    expect(screen.getByLabelText(`Score breakdown for ${SCORING_LOAN.id}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).endsWith('/api/v1/credit/applications/cloan-2/approve')
        )
      ).toBe(true);
    });
  });

  it('renders group loans with co-obligor counts', async () => {
    renderWithProviders(<CreditGroupLoansSection />);
    await waitFor(() => {
      expect(screen.getByText('2 co-obligors')).toBeTruthy();
    });
  });
});
