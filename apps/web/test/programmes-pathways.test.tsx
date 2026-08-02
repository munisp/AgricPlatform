import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { CohortDirectory, CohortDetail } from '@/components/programmes-live';
import { PathwayBrowser, MyPathways, ClubDirectory } from '@/components/pathways-live';

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

const COHORT = {
  id: 'cohort-1',
  name: 'Women in Agribusiness — Kaduna 2026',
  programmeType: 'women',
  capacity: 200,
  enrolmentOpensAt: '2026-01-01T00:00:00.000Z',
  enrolmentClosesAt: '2026-12-01T00:00:00.000Z',
  status: 'open',
  moderatorIds: ['user-mod'],
  createdAt: '2025-12-01T00:00:00.000Z'
};

const MILESTONE = {
  id: 'milestone-1',
  cohortId: 'cohort-1',
  title: 'Business model canvas',
  sequence: 1,
  dueAt: '2026-03-01T00:00:00.000Z'
};

const ENROLMENT = {
  id: 'pe-1',
  cohortId: 'cohort-1',
  userId: 'user-adamu',
  declaredAge: 29,
  status: 'enrolled',
  enrolledAt: '2026-02-01T00:00:00.000Z'
};

const TEMPLATE = {
  id: 'pt-1',
  track: 'nysc',
  name: 'NYSC Agripreneur Pathway',
  description: 'From CDS group to first sale.',
  createdAt: '2025-11-01T00:00:00.000Z'
};

const STAGES = [
  { id: 'stage-1', templateId: 'pt-1', title: 'Orientation', sequence: 1, requiredActions: ['Attend orientation'] },
  { id: 'stage-2', templateId: 'pt-1', title: 'Demo plot', sequence: 2, requiredActions: ['Plant a demo plot'] }
];

const PATHWAY_ENROLMENT = {
  id: 'path-enr-1',
  templateId: 'pt-1',
  userId: 'user-adamu',
  status: 'active',
  currentStageId: 'stage-1',
  enrolledAt: '2026-02-01T00:00:00.000Z'
};

const CLUB = {
  id: 'club-1',
  name: 'ABU Agripreneurs Club',
  institution: 'Ahmadu Bello University',
  state: 'Kaduna',
  coordinatorUserId: 'user-coord',
  isNyscCdsGroup: true,
  memberCount: 45,
  createdAt: '2025-09-01T00:00:00.000Z'
};

function router(url: string, init?: RequestInit) {
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (path.endsWith('/api/v1/programme-cohorts') && (!init?.method || init.method === 'GET')) {
    return jsonResponse({ data: [COHORT], total: 1, page: 1, pageSize: 60 });
  }
  if (path.endsWith(`/api/v1/programme-cohorts/${COHORT.id}/enrolments`) && init?.method === 'POST') {
    return jsonResponse({ data: ENROLMENT });
  }
  if (path.endsWith(`/api/v1/programme-cohorts/${COHORT.id}/milestones`)) {
    return jsonResponse({ data: [MILESTONE] });
  }
  if (path.endsWith(`/api/v1/programme-cohorts/${COHORT.id}/leaderboard`)) {
    return jsonResponse({
      data: [
        { entryUserId: 'user-bisi', totalScore: 87, judgeCount: 3, averageScore: 29, rank: 1 }
      ]
    });
  }
  if (path.endsWith(`/api/v1/programme-cohorts/${COHORT.id}`)) {
    return jsonResponse({ data: COHORT });
  }
  if (path.endsWith('/api/v1/pathway-templates') && (!init?.method || init.method === 'GET')) {
    return jsonResponse({ data: [TEMPLATE] });
  }
  if (path.endsWith(`/api/v1/pathway-templates/${TEMPLATE.id}/enrol`) && init?.method === 'POST') {
    return jsonResponse({ data: PATHWAY_ENROLMENT });
  }
  if (path.endsWith(`/api/v1/pathway-templates/${TEMPLATE.id}`)) {
    return jsonResponse({ data: { template: TEMPLATE, stages: STAGES } });
  }
  if (path.endsWith(`/api/v1/pathway-enrolments/${PATHWAY_ENROLMENT.id}/complete-stage`) && init?.method === 'POST') {
    return jsonResponse({
      data: { ...PATHWAY_ENROLMENT, currentStageId: 'stage-2' }
    });
  }
  if (path.endsWith(`/api/v1/pathway-enrolments/${PATHWAY_ENROLMENT.id}`)) {
    return jsonResponse({
      data: {
        enrolment: PATHWAY_ENROLMENT,
        progress: [
          { id: 'sp-1', enrolmentId: PATHWAY_ENROLMENT.id, stageId: 'stage-1', status: 'pending' }
        ]
      }
    });
  }
  if (path.endsWith('/api/v1/campus-clubs') && (!init?.method || init.method === 'GET')) {
    return jsonResponse({ data: [CLUB] });
  }
  if (path.endsWith(`/api/v1/campus-clubs/${CLUB.id}/members`) && init?.method === 'POST') {
    return jsonResponse({
      data: { id: 'mem-1', clubId: CLUB.id, userId: 'user-adamu', role: 'member', joinedAt: '2026-02-20T00:00:00.000Z' }
    });
  }
  return jsonResponse({ data: null });
}

describe('Programmes', () => {
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

  it('renders the cohort directory with status badges', async () => {
    renderWithProviders(<CohortDirectory />);
    await waitFor(() => {
      expect(screen.getByText('Women in Agribusiness — Kaduna 2026')).toBeTruthy();
    });
    expect(screen.getByText('open')).toBeTruthy();
  });

  it('gates protected threads for non-enrolled members', async () => {
    renderWithProviders(<CohortDetail cohortId={COHORT.id} />);
    await waitFor(() => {
      expect(screen.getByText(/threads are only visible to enrolled members/i)).toBeTruthy();
    });
  });

  it('enrols with declared attributes and reveals the threads panel', async () => {
    renderWithProviders(<CohortDetail cohortId={COHORT.id} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Enrol' })).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Your age (optional)'), { target: { value: '29' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enrol' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, init]) =>
        String(url).includes(`/programme-cohorts/${COHORT.id}/enrolments`) &&
        (init as RequestInit)?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.userId).toBe('user-adamu');
      expect(body.declaredAge).toBe(29);
    });
    await waitFor(() => {
      expect(screen.getByText('enrolled')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeTruthy();
  });

  it('renders the judging leaderboard', async () => {
    renderWithProviders(<CohortDetail cohortId={COHORT.id} />);
    await waitFor(() => {
      expect(screen.getByText('user-bisi')).toBeTruthy();
    });
    expect(screen.getByText('87')).toBeTruthy();
  });
});

describe('Pathways', () => {
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

  it('renders templates with stages and enrols', async () => {
    renderWithProviders(<PathwayBrowser />);
    await waitFor(() => {
      expect(screen.getByText('NYSC Agripreneur Pathway')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'View stages' }));
    await waitFor(() => {
      expect(screen.getByText(/1\. Orientation/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enrol on this pathway' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, init]) =>
        String(url).includes(`/pathway-templates/${TEMPLATE.id}/enrol`) &&
        (init as RequestInit)?.method === 'POST'
      );
      expect(call).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText(/enrolled — see your pathway below/i)).toBeTruthy();
    });
  });

  it('submits stage evidence from the my-pathway view', async () => {
    window.localStorage.setItem(
      'agric.my-pathway-enrolments',
      JSON.stringify({ [PATHWAY_ENROLMENT.id]: TEMPLATE.name })
    );
    renderWithProviders(<MyPathways />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Evidence for "Orientation"/)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/Evidence for "Orientation"/), {
      target: { value: 'Attended on 12 Feb at the state secretariat' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit evidence' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, init]) =>
        String(url).includes(`/pathway-enrolments/${PATHWAY_ENROLMENT.id}/complete-stage`) &&
        (init as RequestInit)?.method === 'POST'
      );
      expect(call).toBeTruthy();
      expect(
        JSON.parse((call![1] as RequestInit).body as string).evidence
      ).toBe('Attended on 12 Feb at the state secretariat');
    });
  });

  it('renders campus clubs with NYSC CDS badge and join action', async () => {
    renderWithProviders(<ClubDirectory />);
    await waitFor(() => {
      expect(screen.getByText('ABU Agripreneurs Club')).toBeTruthy();
    });
    expect(screen.getByText('NYSC CDS group')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Join club' }));
    await waitFor(() => {
      expect(screen.getByText('joined')).toBeTruthy();
    });
  });
});
