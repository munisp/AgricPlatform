import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { AttendanceCheckIn } from '@/components/attendance-check-in';

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

describe('Attendance check-in', () => {
  const fetchMock = vi.fn();

  function setup(scanResponse: () => Promise<Response>) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/api/v1/chapters')) {
        return jsonResponse({ data: [CHAPTER], total: 1, page: 1, pageSize: 5 });
      }
      if (path.endsWith(`/api/v1/chapters/${CHAPTER.id}/events`)) {
        return jsonResponse({ data: [EVENT] });
      }
      if (path.endsWith(`/api/v1/events/${EVENT.id}/attendance/scan`) && init?.method === 'POST') {
        return scanResponse();
      }
      return jsonResponse({ data: null });
    });
  }

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('checks in successfully with a valid code', async () => {
    setup(() => jsonResponse({ data: { eventId: EVENT.id, userId: 'user-adamu', status: 'attended' } }));
    renderWithProviders(<AttendanceCheckIn />);

    await waitFor(() => {
      expect(screen.getByLabelText('Event')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Attendance code'), {
      target: { value: 'v1.event-field-day.123456.abcd-signature' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));

    await waitFor(() => {
      expect(screen.getByText(/You are checked in/i)).toBeTruthy();
    });
  });

  it('displays the 409 duplicate scan gracefully (not as an error)', async () => {
    setup(() =>
      jsonResponse(
        {
          statusCode: 409,
          error: 'Conflict',
          message: 'Attendance already recorded for this member',
          path: `/events/${EVENT.id}/attendance/scan`,
          timestamp: new Date().toISOString()
        },
        409
      )
    );
    renderWithProviders(<AttendanceCheckIn />);

    await waitFor(() => {
      expect(screen.getByLabelText('Event')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Attendance code'), {
      target: { value: 'v1.event-field-day.123456.abcd-signature' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));

    await waitFor(() => {
      expect(screen.getByTestId('duplicate-scan')).toBeTruthy();
    });
    expect(screen.getByTestId('duplicate-scan').textContent).toContain('Already checked in');
    // No error alert is shown for the duplicate case.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an error notice for an invalid code (400)', async () => {
    setup(() =>
      jsonResponse(
        {
          statusCode: 400,
          error: 'Bad Request',
          message: 'Malformed attendance code',
          path: `/events/${EVENT.id}/attendance/scan`,
          timestamp: new Date().toISOString()
        },
        400
      )
    );
    renderWithProviders(<AttendanceCheckIn />);

    await waitFor(() => {
      expect(screen.getByLabelText('Event')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Attendance code'), {
      target: { value: 'v1.event-field-day.123456.abcd-signature' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Malformed attendance code');
    });
    expect(screen.queryByTestId('duplicate-scan')).toBeNull();
  });
});
