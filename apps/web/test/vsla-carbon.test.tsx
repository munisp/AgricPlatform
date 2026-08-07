import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import {
  BasisBadge,
  CarbonPlotsSection,
  MrvReportSection,
  VslaCycleSection,
  VslaGroupsSection,
  VslaLoansSection
} from '@/components/vsla-carbon-live';

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

const GROUP = {
  id: 'vsla-1',
  name: 'Kano Women Savings',
  leadUserId: 'user-lead',
  status: 'ACTIVE',
  savingsAccountCode: 'vsla:vsla-1:cash',
  loansReceivableAccountCode: 'vsla:vsla-1:loans_receivable',
  interestIncomeAccountCode: 'vsla:vsla-1:interest_income',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const MEMBER = {
  id: 'vslamember-1',
  groupId: 'vsla-1',
  userId: 'user-farmer',
  role: 'member',
  status: 'ACTIVE',
  joinedAt: '2026-01-01T00:00:00.000Z'
};

const CYCLE = {
  id: 'vslacycle-1',
  groupId: 'vsla-1',
  label: '2026 Cycle 1',
  status: 'OPEN',
  openedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z'
};

const CONTRIBUTION = {
  id: 'vslacontrib-1',
  cycleId: 'vslacycle-1',
  groupId: 'vsla-1',
  memberId: 'vslamember-1',
  amountKobo: 50_000,
  idempotencyKey: 'k1',
  ledgerEntryId: 'entry-1',
  createdAt: '2026-01-02T00:00:00.000Z'
};

const LOAN = {
  id: 'vslaloan-1',
  groupId: 'vsla-1',
  cycleId: 'vslacycle-1',
  memberId: 'vslamember-1',
  principalKobo: 100_000,
  interestRateBps: 1_000,
  totalDueKobo: 110_000,
  repaidKobo: 0,
  status: 'ACTIVE',
  issuedAt: '2026-01-03T00:00:00.000Z',
  ledgerEntryId: 'entry-2',
  createdAt: '2026-01-03T00:00:00.000Z'
};

const PLOT = {
  id: 'carbonplot-1',
  groupId: 'vsla-1',
  ownerUserId: 'user-farmer',
  name: 'FMNR plot A',
  practiceType: 'fmnr',
  hectaresCenti: 250,
  centroidLat: 11.0855,
  centroidLong: 7.7199,
  h3Res9: '89354e2813bffff',
  status: 'ACTIVE',
  createdAt: '2026-01-04T00:00:00.000Z'
};

const GROUP_REPORT = {
  groupId: 'vsla-1',
  groupName: 'Kano Women Savings',
  plotCount: 1,
  hectaresUnderPractice: 2.5,
  meanSurvivalRatePct: 80,
  estimatedCo2eTonnes: 9,
  estimateCount: 1,
  evidenceCount: 2,
  ndviLinkedEvidenceCount: 1,
  basisFlags: ['stub', 'estimate'],
  disclaimer: 'Estimate only — not verification-grade; no carbon credits are issued, traded or implied.'
};

const PROGRAMME_REPORT = {
  ...GROUP_REPORT,
  groupCount: 1,
  groups: [GROUP_REPORT],
  generatedAt: '2026-02-01T00:00:00.000Z'
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

describe('VSLA groups UI', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists groups and shows an empty state when none exist', async () => {
    stubApi(fetchMock, { '/vsla-carbon/groups': { data: [GROUP] } });
    renderWithProviders(<VslaGroupsSection selectedGroupId={null} onSelect={() => undefined} />);
    await screen.findByText('Kano Women Savings');
    expect(screen.getByText('ACTIVE')).toBeTruthy();

    cleanup();
    clearApiCache();
    stubApi(fetchMock, { '/vsla-carbon/groups': { data: [] } });
    renderWithProviders(<VslaGroupsSection selectedGroupId={null} onSelect={() => undefined} />);
    await screen.findByText('No VSLA groups yet.');
  });

  it('creates a group via the form', async () => {
    stubApi(fetchMock, {
      '/vsla-carbon/groups': { data: [GROUP] }
    });
    renderWithProviders(<VslaGroupsSection selectedGroupId={null} onSelect={() => undefined} />);
    await screen.findByText('Kano Women Savings');
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'New Group' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register group' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({ name: 'New Group' });
    });
  });
});

describe('VSLA cycle + contributions UI', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the open cycle and its contributions in whole naira', async () => {
    stubApi(fetchMock, {
      [`/vsla-carbon/groups/${GROUP.id}/cycles`]: { data: [CYCLE] },
      [`/vsla-carbon/groups/${GROUP.id}/members`]: { data: [MEMBER] },
      [`/vsla-carbon/cycles/${CYCLE.id}/contributions`]: { data: [CONTRIBUTION] }
    });
    renderWithProviders(<VslaCycleSection groupId={GROUP.id} />);
    await screen.findByText('₦500');
    expect(screen.getByTestId('open-cycle-label').textContent).toContain('2026 Cycle 1');
    expect(screen.getByText('OPEN')).toBeTruthy();
  });

  it('records a contribution with a generated idempotency key', async () => {
    stubApi(fetchMock, {
      [`/vsla-carbon/groups/${GROUP.id}/cycles`]: { data: [CYCLE] },
      [`/vsla-carbon/groups/${GROUP.id}/members`]: { data: [MEMBER] },
      [`/vsla-carbon/cycles/${CYCLE.id}/contributions`]: { data: [] }
    });
    renderWithProviders(<VslaCycleSection groupId={GROUP.id} />);
    await screen.findByText('No contributions yet.');
    fireEvent.change(screen.getByLabelText('Member'), { target: { value: MEMBER.id } });
    fireEvent.change(screen.getByLabelText('Amount (₦)'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record contribution' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).includes('/contributions') &&
          (init as RequestInit | undefined)?.method === 'POST'
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(String((post?.[1] as RequestInit).body));
      expect(body.memberId).toBe(MEMBER.id);
      expect(body.amountKobo).toBe(5_000);
      expect(body.idempotencyKey).toMatch(/^web-contrib-/);
    });
  });
});

describe('VSLA loans UI', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists loans with principal, total due and status', async () => {
    stubApi(fetchMock, {
      [`/vsla-carbon/groups/${GROUP.id}/loans`]: { data: [LOAN] },
      [`/vsla-carbon/groups/${GROUP.id}/members`]: { data: [MEMBER] }
    });
    renderWithProviders(<VslaLoansSection groupId={GROUP.id} />);
    await screen.findByText('₦1,000');
    expect(screen.getByText('₦1,100')).toBeTruthy();
    expect(screen.getByText('ACTIVE')).toBeTruthy();
  });

  it('shows an empty state when the group has no loans', async () => {
    stubApi(fetchMock, {
      [`/vsla-carbon/groups/${GROUP.id}/loans`]: { data: [] },
      [`/vsla-carbon/groups/${GROUP.id}/members`]: { data: [] }
    });
    renderWithProviders(<VslaLoansSection groupId={GROUP.id} />);
    await screen.findByText('No loans yet.');
  });
});

describe('carbon plots + MRV honesty labels', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    // Blob downloads in jsdom need the URL factory mocked (mirrors the
    // analytics-export test pattern).
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:mock-1'),
        revokeObjectURL: vi.fn()
      })
    );
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      /* captured — no jsdom navigation */
    };
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists plots with hectares, H3 index and an ESTIMATE badge', async () => {
    stubApi(fetchMock, {
      '/vsla-carbon/plots': { data: [PLOT] }
    });
    renderWithProviders(<CarbonPlotsSection groupId={GROUP.id} />);
    await screen.findByText(/FMNR plot A/);
    expect(screen.getByText(/2.50 ha/)).toBeTruthy();
    expect(screen.getByText(/89354e2813bffff/)).toBeTruthy();
    expect(screen.getAllByText('ESTIMATE — not verification-grade').length).toBeGreaterThan(0);
  });

  it('renders the basis badge trio honestly (stub never upgraded)', () => {
    renderWithProviders(
      <div>
        <BasisBadge basis="stub" />
        <BasisBadge basis="estimate" />
        <BasisBadge basis="live" />
      </div>
    );
    expect(screen.getByText('STUB — simulated')).toBeTruthy();
    expect(screen.getByText('ESTIMATE — not verification-grade')).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeTruthy();
  });

  it('renders the programme MRV report with basis flags, disclaimer and CSV export', async () => {
    stubApi(fetchMock, {
      '/vsla-carbon/reports/programme': { data: PROGRAMME_REPORT }
    });
    renderWithProviders(<MrvReportSection groupId={null} />);
    const summary = await screen.findByTestId('programme-mrv-summary');
    expect(summary.textContent).toContain('2.50 ha');
    expect(summary.textContent).toContain('9.000 t CO2e');
    expect(screen.getAllByText(/not verification-grade/).length).toBeGreaterThan(0);
    const csv = screen.getByTestId('mrv-csv-download');
    expect(csv.textContent).toContain('Download CSV export');
    // Triggering the download calls the export endpoint with format=csv.
    fetchMock.mockResolvedValueOnce(new Response('group_id\nvsla-1', { status: 200 }));
    fireEvent.click(csv);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/vsla-carbon/reports/export')
      );
      expect(call).toBeTruthy();
      expect(String(call?.[0])).toContain('format=csv');
    });
    await screen.findByText(/downloaded vsla-carbon-mrv.csv/);
  });
});
