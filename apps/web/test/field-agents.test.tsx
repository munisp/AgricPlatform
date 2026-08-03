import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { getDraftsDb } from '@/lib/drafts';
import { AgentsBoard } from '@/components/agents-board';
import { AgentQueue } from '@/components/agent-queue';

expect.extend(toHaveNoViolations);

// jsdom does no layout and the stylesheet is not loaded — color contrast is
// covered by test/contrast.test.ts against the CSS source.
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

const ASSIGNMENT = {
  id: 'asgn-1',
  agentUserId: 'user-enumerator',
  state: 'Kaduna',
  lga: 'Zaria',
  purpose: 'farmer-registration',
  targetCount: 4,
  completedCount: 1,
  status: 'in_progress',
  createdBy: 'user-admin',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-02T00:00:00.000Z'
};

const PRODUCTIVITY = {
  agentUserId: 'user-enumerator',
  totalAssignments: 2,
  activeAssignments: 1,
  completedAssignments: 1,
  cancelledAssignments: 0,
  targetCount: 8,
  completedCount: 5,
  completionRate: 0.625
};

describe('AgentsBoard (admin/chapter lead console)', () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    clearApiCache();
    window.localStorage.clear();
    window.sessionStorage.clear();
    previewRole('admin', 'user-admin');
    vi.stubGlobal('fetch', fetchMock);
    const db = getDraftsDb();
    if (db) await db.drafts.clear();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? 'GET';
      if (path.endsWith('/api/v1/field-agents/assignments') && method === 'GET') {
        return jsonResponse({ data: [ASSIGNMENT] });
      }
      if (path.endsWith('/api/v1/field-agents/assignments') && method === 'POST') {
        return jsonResponse({ data: { ...ASSIGNMENT, id: 'asgn-2', status: 'assigned' } });
      }
      if (path.endsWith('/api/v1/field-agents/assignments/asgn-1/cancel') && method === 'POST') {
        return jsonResponse({ data: { ...ASSIGNMENT, status: 'cancelled' } });
      }
      if (path.endsWith('/api/v1/field-agents/productivity') && method === 'GET') {
        return jsonResponse({ data: [PRODUCTIVITY] });
      }
      return jsonResponse({ data: null });
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('lists assignments with progress bars', async () => {
    renderWithProviders(<AgentsBoard />);
    await waitFor(() => expect(screen.getByText('farmer-registration')).toBeTruthy());
    expect(screen.getByText('1 of 4 done')).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('creates an assignment from the form', async () => {
    renderWithProviders(<AgentsBoard />);
    await waitFor(() => expect(screen.getByText('farmer-registration')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Enumerator user id'), {
      target: { value: 'user-enumerator' }
    });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Kano' } });
    fireEvent.change(screen.getByLabelText('LGA'), { target: { value: 'Kano Municipal' } });
    fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'farm-visit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create assignment' }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith('/api/v1/field-agents/assignments') &&
          (init as RequestInit | undefined)?.method === 'POST'
      );
      expect(calls).toHaveLength(1);
      const body = JSON.parse(String((calls[0][1] as RequestInit).body));
      expect(body.agentUserId).toBe('user-enumerator');
      expect(body.purpose).toBe('farm-visit');
    });
  });

  it('cancels an open assignment', async () => {
    renderWithProviders(<AgentsBoard />);
    await waitFor(() => expect(screen.getByText('farmer-registration')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel assignment' }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/api/v1/field-agents/assignments/asgn-1/cancel')
      );
      expect(calls).toHaveLength(1);
    });
  });

  it('shows the productivity table for admins', async () => {
    renderWithProviders(<AgentsBoard />);
    // Wait for the DATA (the section header renders before the fetch lands).
    await waitFor(() => expect(screen.getByText('63%')).toBeTruthy());
    expect(screen.getByText('Completion per enumerator')).toBeTruthy();
  });

  it('hides the productivity table for chapter leads', async () => {
    previewRole('chapter_lead', 'user-lead-kaduna');
    renderWithProviders(<AgentsBoard />);
    await waitFor(() => expect(screen.getByText('farmer-registration')).toBeTruthy());
    expect(screen.queryByText('Completion per enumerator')).toBeNull();
    const productivityCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/api/v1/field-agents/productivity')
    );
    expect(productivityCalls).toHaveLength(0);
  });

  it('wraps the productivity table in the responsive table pattern', async () => {
    renderWithProviders(<AgentsBoard />);
    await waitFor(() => expect(screen.getByText('63%')).toBeTruthy());
    const table = screen.getByRole('table');
    expect(table.className).toBe('table');
    expect(table.parentElement?.className).toBe('table-wrap');
  });

  it('shows the translated validation error when required fields are missing', async () => {
    renderWithProviders(<AgentsBoard />);
    await waitFor(() => expect(screen.getByText('farmer-registration')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Create assignment' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'Could not create the assignment — check the details and try again.'
      );
    });
    const posts = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
    );
    expect(posts).toHaveLength(0);
  });

  it('autosaves the assignment draft and restores it after a remount', async () => {
    const first = renderWithProviders(<AgentsBoard />);
    await waitFor(() => expect(screen.getByText('farmer-registration')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Enumerator user id'), {
      target: { value: 'user-enumerator' }
    });
    fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'farm-visit' } });
    await waitFor(
      async () => {
        const record = await getDraftsDb()?.drafts.get('agents.assignment.new');
        expect(record?.data).toMatchObject({
          agentUserId: 'user-enumerator',
          purpose: 'farm-visit'
        });
      },
      { timeout: 3000 }
    );
    first.unmount();

    renderWithProviders(<AgentsBoard />);
    await waitFor(() => {
      expect((screen.getByLabelText('Enumerator user id') as HTMLInputElement).value).toBe(
        'user-enumerator'
      );
    });
    expect((screen.getByLabelText('Purpose') as HTMLInputElement).value).toBe('farm-visit');
  });

  it('has no accessibility violations (board composite)', async () => {
    const { container } = renderWithProviders(<AgentsBoard />);
    await waitFor(() => expect(screen.getByText('63%')).toBeTruthy());
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('AgentQueue (enumerator)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    window.localStorage.clear();
    window.sessionStorage.clear();
    previewRole('enumerator', 'user-enumerator');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? 'GET';
      if (path.endsWith('/api/v1/field-agents/assignments/mine') && method === 'GET') {
        return jsonResponse({ data: [ASSIGNMENT] });
      }
      if (
        path.endsWith('/api/v1/field-agents/assignments/asgn-1/progress') &&
        method === 'POST'
      ) {
        return jsonResponse({ data: { ...ASSIGNMENT, completedCount: 2 } });
      }
      if (path.endsWith('/api/v1/field-agents/capture/profile') && method === 'POST') {
        return jsonResponse({
          data: {
            profile: { userId: 'user-adamu' },
            farmerUserId: 'user-adamu',
            consentId: 'consent-1',
            capturedBy: 'user-enumerator'
          }
        });
      }
      return jsonResponse({ data: null });
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('lists the enumerator queue and reports progress', async () => {
    renderWithProviders(<AgentQueue />);
    await waitFor(() => expect(screen.getByText('farmer-registration')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Report progress' }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([url, init]) =>
        String(url).endsWith('/api/v1/field-agents/assignments/asgn-1/progress') &&
        (init as RequestInit | undefined)?.method === 'POST'
      );
      expect(calls).toHaveLength(1);
    });
  });

  it('captures a farmer profile on behalf and shows the consent reference', async () => {
    renderWithProviders(<AgentQueue />);
    await waitFor(() => expect(screen.getByText('farmer-registration')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Farmer phone (or user id above)'), {
      target: { value: '+2348012345678' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save farmer profile' }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([url, init]) =>
        String(url).endsWith('/api/v1/field-agents/capture/profile') &&
        (init as RequestInit | undefined)?.method === 'POST'
      );
      expect(calls).toHaveLength(1);
      const body = JSON.parse(String((calls[0][1] as RequestInit).body));
      expect(body.farmerPhone).toBe('+2348012345678');
    });
    await waitFor(() =>
      expect(screen.getByText(/Consent consent-1 recorded/)).toBeTruthy()
    );
  });
});
