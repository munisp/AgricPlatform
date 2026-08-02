import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { ResourceLibrary, PodcastList, WebinarList } from '@/components/knowledge-live';

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

const RESOURCE = {
  id: 'kr-maize',
  title: 'Maize spacing guide',
  body: 'Plant 75cm between ridges and 25cm within rows.',
  tags: ['maize'],
  language: 'en',
  format: 'article',
  offlineAvailable: true,
  viewCount: 312,
  publishedAt: '2026-01-15T00:00:00.000Z'
};

const EPISODE = {
  id: 'ep-1',
  title: 'Episode 4: Post-harvest storage',
  showNotes: 'We talk hermetic bags and moisture meters.',
  audioUrl: 'https://cdn.example.com/ep4.mp3',
  durationSeconds: 1500,
  transcript: 'Welcome to episode four. Today we discuss post-harvest storage…',
  publishedAt: '2026-02-01T00:00:00.000Z'
};

const WEBINAR_UPCOMING = {
  id: 'web-1',
  title: 'Dry season planning Q&A',
  hostUserId: 'user-host',
  startsAt: '2099-05-01T10:00:00.000Z',
  timezone: 'Africa/Lagos',
  status: 'scheduled',
  createdAt: '2026-01-01T00:00:00.000Z'
};

const WEBINAR_PAST = {
  id: 'web-2',
  title: 'Wet season recap',
  hostUserId: 'user-host',
  startsAt: '2020-05-01T10:00:00.000Z',
  timezone: 'Africa/Lagos',
  recordingUrl: 'https://cdn.example.com/recaps/wet-season.mp4',
  status: 'completed',
  createdAt: '2020-01-01T00:00:00.000Z'
};

describe('Knowledge base', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/api/v1/knowledge-resources')) {
        return jsonResponse({ data: [RESOURCE], total: 1, page: 1, pageSize: 60 });
      }
      if (path.endsWith('/api/v1/podcast-episodes')) {
        return jsonResponse({ data: [EPISODE] });
      }
      if (path.endsWith(`/api/v1/webinars/${WEBINAR_UPCOMING.id}/registrations`) && init?.method === 'POST') {
        return jsonResponse({
          data: { id: 'reg-1', webinarId: WEBINAR_UPCOMING.id, userId: 'user-adamu', registeredAt: '2026-02-20T00:00:00.000Z' }
        });
      }
      if (path.endsWith('/api/v1/webinars')) {
        return jsonResponse({ data: [WEBINAR_UPCOMING, WEBINAR_PAST] });
      }
      return jsonResponse({ data: null });
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders resources with the offline-ready badge and readable body', async () => {
    renderWithProviders(<ResourceLibrary />);
    await waitFor(() => {
      expect(screen.getByText('Maize spacing guide')).toBeTruthy();
    });
    expect(screen.getByText('offline-ready')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    expect(screen.getByText('Plant 75cm between ridges and 25cm within rows.')).toBeTruthy();
  });

  it('applies tag and format filters to the request', async () => {
    renderWithProviders(<ResourceLibrary />);
    await waitFor(() => {
      expect(screen.getByText('Maize spacing guide')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'rice' } });
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'video' } });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => {
        const parsed = new URL(String(url));
        return (
          parsed.pathname.endsWith('/api/v1/knowledge-resources') &&
          parsed.searchParams.get('tag') === 'rice' &&
          parsed.searchParams.get('format') === 'video'
        );
      });
      expect(call).toBeTruthy();
    });
  });

  it('shows the podcast transcript as semantic text on the episode detail', async () => {
    renderWithProviders(<PodcastList />);
    await waitFor(() => {
      expect(screen.getByText('Episode 4: Post-harvest storage')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Listen / read' }));
    expect(screen.getByRole('heading', { name: 'Transcript' })).toBeTruthy();
    expect(
      screen.getByText('Welcome to episode four. Today we discuss post-harvest storage…')
    ).toBeTruthy();
  });

  it('registers for an upcoming webinar and shows recording links for past ones', async () => {
    renderWithProviders(<WebinarList />);
    await waitFor(() => {
      expect(screen.getByText('Dry season planning Q&A')).toBeTruthy();
    });

    // Past webinar: recording link instead of a register button.
    expect(screen.getByRole('link', { name: 'Watch recording' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    await waitFor(() => {
      expect(screen.getByText('registered')).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes(`/webinars/${WEBINAR_UPCOMING.id}/registrations`) &&
      (init as RequestInit)?.method === 'POST'
    );
    expect(call).toBeTruthy();
    expect(JSON.parse((call![1] as RequestInit).body as string).userId).toBe('user-adamu');
  });
});
