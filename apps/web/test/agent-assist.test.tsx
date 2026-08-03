import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { AgentAssistQueue, slaAgeLabel } from '@/components/agent-assist-queue';
import { AgentAssistCase } from '@/components/agent-assist-case';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

const CASE_OPEN = {
  id: 'vcase-1',
  sessionId: 'vsession-1',
  phone: '+2348012345678',
  channel: 'ussd',
  status: 'open',
  reason: 'no_grounding',
  priority: 'high',
  slaDueAt: new Date(Date.now() - 3_600_000).toISOString(), // 1h overdue
  citationChunkIds: [],
  suggestedAnswer: 'Based on the AgricPlatform advisory library: 1) Fall armyworm watch — scout twice weekly. Sources: advisory:adv-fall-armyworm:0.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const CASE_RESOLVED = {
  ...CASE_OPEN,
  id: 'vcase-2',
  status: 'resolved',
  priority: 'normal',
  slaDueAt: new Date(Date.now() + 7_200_000).toISOString(),
  response: 'Agent answer',
  assignedAgentId: 'user-agent-1'
};

const DETAIL = {
  agentCase: CASE_OPEN,
  session: {
    id: 'vsession-1',
    channel: 'ussd',
    state: 'escalated',
    phone: '+2348012345678',
    locale: 'ha',
    crop: 'Maize',
    menuState: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  },
  turns: [
    {
      id: 'vturn-1',
      sessionId: 'vsession-1',
      turnIndex: 1,
      speaker: 'farmer',
      text: '1',
      citedChunkIds: [],
      createdAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'vturn-2',
      sessionId: 'vsession-1',
      turnIndex: 2,
      speaker: 'assistant',
      text: 'I cannot answer that confidently from our advisory library. I am connecting you to an agronomist who will follow up shortly.',
      citedChunkIds: [],
      confidence: 0.2,
      createdAt: '2026-01-01T00:01:00.000Z'
    }
  ]
};

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn().mockImplementation(handler);
}

function renderQueue() {
  return render(
    <AppProvider>
      <I18nProvider>
        <AgentAssistQueue />
      </I18nProvider>
    </AppProvider>
  );
}

function renderCase(id = 'vcase-1') {
  return render(
    <AppProvider>
      <I18nProvider>
        <AgentAssistCase caseId={id} />
      </I18nProvider>
    </AppProvider>
  );
}

describe('slaAgeLabel', () => {
  it('labels overdue and in-time deadlines', () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z');
    expect(slaAgeLabel('2026-01-01T10:00:00.000Z', now)).toEqual({ text: '2h overdue', overdue: true });
    expect(slaAgeLabel('2026-01-01T15:00:00.000Z', now)).toEqual({ text: 'due in 3h', overdue: false });
  });
});

describe('AgentAssistQueue', () => {
  beforeEach(() => clearApiCache());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders cases with status, channel badge and overdue marker', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch((url) =>
        url.includes('/voice/agent-cases') ? jsonResponse({ data: [CASE_OPEN, CASE_RESOLVED] }) : jsonResponse({}, 404)
      )
    );
    renderQueue();
    await waitFor(() => expect(screen.getByText(/\+2348012345678/)).toBeTruthy());
    expect(screen.getByText('ussd')).toBeTruthy();
    expect(screen.getByText('overdue')).toBeTruthy();
    expect(screen.getByText(/1h overdue/)).toBeTruthy();
    // Default view hides the resolved case.
    expect(screen.queryByText('Agent answer')).toBeNull();
  });

  it('"All statuses" view includes resolved cases', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => jsonResponse({ data: [CASE_OPEN, CASE_RESOLVED] }))
    );
    renderQueue();
    await waitFor(() => expect(screen.getByText('ussd')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } });
    await waitFor(() => expect(screen.getByText('resolved')).toBeTruthy());
  });

  it('overdue-only filter calls the API with overdue=true', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ data: [CASE_OPEN] }));
    vi.stubGlobal('fetch', fetchMock);
    renderQueue();
    await waitFor(() => expect(screen.getByText('ussd')).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/Overdue only/));
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes('overdue=true'))).toBe(true);
    });
  });

  it('shows the empty state when the queue is clear', async () => {
    vi.stubGlobal('fetch', mockFetch(() => jsonResponse({ data: [] })));
    renderQueue();
    await waitFor(() =>
      expect(screen.getByText(/No cases in this view/)).toBeTruthy()
    );
  });

  it('maps API failures to the error state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    renderQueue();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });

  it('case rows link to the case detail route', async () => {
    vi.stubGlobal('fetch', mockFetch(() => jsonResponse({ data: [CASE_OPEN] })));
    renderQueue();
    await waitFor(() => expect(screen.getByText('ussd')).toBeTruthy());
    const link = screen.getByRole('link', { name: /Case detail/ });
    expect(link.getAttribute('href')).toBe('/agent-assist/vcase-1');
  });
});

describe('AgentAssistCase', () => {
  beforeEach(() => clearApiCache());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockDetailFetch(detail: unknown = DETAIL) {
    return mockFetch((url: string) => {
      if (url.includes('/respond')) {
        return jsonResponse({ data: { agentCase: { ...CASE_OPEN, status: 'resolved' }, session: DETAIL.session } });
      }
      if (url.includes('/voice/agent-cases/')) {
        return jsonResponse({ data: detail });
      }
      return jsonResponse({}, 404);
    });
  }

  it('renders the transcript with speaker labels and the safe-fallback badge', async () => {
    vi.stubGlobal('fetch', mockDetailFetch());
    renderCase();
    await waitFor(() => expect(screen.getByText('Farmer')).toBeTruthy());
    expect(screen.getByText('Assistant')).toBeTruthy();
    expect(screen.getByText('safe fallback')).toBeTruthy();
    expect(screen.getByText(/connecting you to an agronomist/)).toBeTruthy();
  });

  it('shows the en-only locale note for a non-en session and pre-fills the suggested answer', async () => {
    vi.stubGlobal('fetch', mockDetailFetch());
    renderCase();
    await waitFor(() => expect(screen.getByText(/English-only pending/)).toBeTruthy());
    const textarea = screen.getByLabelText(/Your response/) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toContain('Fall armyworm watch'));
  });

  it('sends a response with resolve=true and shows the resolved notice', async () => {
    const fetchMock = mockDetailFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderCase();
    await waitFor(() => expect(screen.getByText('Farmer')).toBeTruthy());
    const textarea = screen.getByLabelText(/Your response/) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toContain('Fall armyworm watch'));
    fireEvent.click(screen.getByRole('button', { name: /Send and resolve/ }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('resolved'));
    const respondCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/respond'));
    expect(respondCall).toBeTruthy();
    const body = JSON.parse(String((respondCall![1] as RequestInit).body));
    expect(body.resolve).toBe(true);
    expect(body.response).toContain('Fall armyworm watch');
  });

  it('resolved cases are read-only (no send buttons)', async () => {
    vi.stubGlobal('fetch', mockDetailFetch({ ...DETAIL, agentCase: CASE_RESOLVED }));
    renderCase('vcase-2');
    await waitFor(() => expect(screen.getByText('Farmer')).toBeTruthy());
    const send = screen.getByRole('button', { name: /Send and resolve/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect((screen.getByLabelText(/Your response/) as HTMLTextAreaElement).disabled).toBe(true);
  });
});
