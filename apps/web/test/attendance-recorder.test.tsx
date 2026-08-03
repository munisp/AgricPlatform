import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { AttendanceRecorder } from '@/components/attendance-recorder';

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

const CHAPTER = {
  id: 'chapter-kano',
  name: 'Kano State Chapter',
  level: 'state',
  state: 'Kano',
  memberCount: 100,
  active: true
};

const EVENT = {
  id: 'event-field-day',
  chapterId: 'chapter-kano',
  title: 'Maize Field Day',
  type: 'field_day',
  location: 'Kano',
  startsAt: '2026-04-01T09:00:00.000Z',
  rsvpCount: 40,
  attendanceCount: 10
};

const ROSTER = [
  { userId: 'user-adamu', fullName: 'Adamu Bello', status: 'rsvp' },
  { userId: 'user-aisha', fullName: 'Aisha Yusuf', status: 'attended' }
];

describe('AttendanceRecorder (G7)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    window.localStorage.clear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('fetches the real roster from the events roster API', async () => {
    fetchMock.mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/api/v1/chapters')) {
        return jsonResponse({ data: [CHAPTER], total: 1, page: 1, pageSize: 5 });
      }
      if (path.endsWith(`/api/v1/chapters/${CHAPTER.id}/events`)) {
        return jsonResponse({ data: [EVENT] });
      }
      if (path.endsWith(`/api/v1/events/${EVENT.id}/roster`)) {
        return jsonResponse({ data: ROSTER });
      }
      return jsonResponse({ error: { message: 'not found' } }, 404);
    });

    renderWithProviders(<AttendanceRecorder />);

    // Real member names from the API, not the demo roster.
    expect(await screen.findByText('Adamu Bello')).toBeTruthy();
    expect(await screen.findByText('Aisha Yusuf')).toBeTruthy();
    expect(screen.queryByText(/Adamu Garba/)).not.toBeTruthy();
    // No offline notice when live data is served.
    expect(screen.queryByText(/showing reference members/i)).not.toBeTruthy();
    // RSVP status metadata is shown honestly.
    expect(screen.getByText('Already checked in')).toBeTruthy();

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) =>
          new URL(url as string).pathname.endsWith(`/api/v1/events/${EVENT.id}/roster`)
        )
      ).toBe(true);
    });
  });

  it('labels the demo roster with an offline notice when the API is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    renderWithProviders(<AttendanceRecorder />);

    // Demo members appear, clearly marked as reference data.
    expect(await screen.findByText(/showing reference members/i)).toBeTruthy();
    expect(screen.getByText(/Adamu Garba \(demo\)/)).toBeTruthy();
    expect(screen.getByText(/showing reference events/i)).toBeTruthy();
  });
});
