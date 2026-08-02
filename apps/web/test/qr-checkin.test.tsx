import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { AttendanceCheckIn } from '@/components/attendance-check-in';
import { isCameraSupported } from '@/components/qr-scanner';

vi.mock('jsqr', () => ({
  default: vi.fn(() => ({ data: 'v1.event-abc123def' }))
}));

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

const CHAPTER = { id: 'ch-1', name: 'Kano Farmers Circle' };
const EVENT = { id: 'evt-1', chapterId: 'ch-1', title: 'Field day', status: 'upcoming' };

function stubMediaDevices(getUserMedia?: unknown) {
  Object.defineProperty(window.navigator, 'mediaDevices', {
    value: getUserMedia ? { getUserMedia } : undefined,
    configurable: true
  });
}

function fakeStream() {
  return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
}

function stubVideoAndCanvas() {
  Object.defineProperty(window.HTMLVideoElement.prototype, 'readyState', {
    get: () => 2,
    configurable: true
  });
  Object.defineProperty(window.HTMLVideoElement.prototype, 'videoWidth', {
    get: () => 640,
    configurable: true
  });
  Object.defineProperty(window.HTMLVideoElement.prototype, 'videoHeight', {
    get: () => 480,
    configurable: true
  });
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({
      drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })
    }),
    configurable: true
  });
}

describe('QR check-in', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? 'GET';
      if (path.endsWith('/api/v1/chapters')) {
        return jsonResponse({ data: [CHAPTER], total: 1, page: 1, pageSize: 5 });
      }
      if (path.endsWith(`/api/v1/chapters/${CHAPTER.id}/events`)) {
        return jsonResponse({ data: [EVENT] });
      }
      if (path.endsWith(`/api/v1/events/${EVENT.id}/attendance/scan`) && method === 'POST') {
        return jsonResponse({ data: { recorded: true } });
      }
      return jsonResponse({ data: null });
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window.navigator, 'mediaDevices');
    Reflect.deleteProperty(window.HTMLVideoElement.prototype, 'readyState');
    Reflect.deleteProperty(window.HTMLVideoElement.prototype, 'videoWidth');
    Reflect.deleteProperty(window.HTMLVideoElement.prototype, 'videoHeight');
    Reflect.deleteProperty(window.HTMLCanvasElement.prototype, 'getContext');
  });

  it('hides the camera option when the browser has no camera support', async () => {
    stubMediaDevices(undefined);
    expect(isCameraSupported()).toBe(false);
    renderWithProviders(<AttendanceCheckIn />);
    await waitFor(() => {
      expect(screen.getByLabelText('Attendance code')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Scan with camera' })).toBeNull();
  });

  it('falls back to the paste-in flow when camera permission is denied', async () => {
    stubMediaDevices(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')));
    renderWithProviders(<AttendanceCheckIn />);

    // Wait for the real events to load so the check-in targets evt-1.
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Field day' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Scan with camera' }));

    await waitFor(() => {
      expect(screen.getByTestId('camera-fallback')).toBeTruthy();
    });
    expect(screen.getByText(/Camera permission was denied/)).toBeTruthy();

    // Paste flow still works after the fallback.
    fireEvent.change(screen.getByLabelText('Attendance code'), {
      target: { value: 'v1.event-manual-entry' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));
    await waitFor(() => {
      expect(screen.getByText(/You are checked in/)).toBeTruthy();
    });
  });

  it('scans a QR code with the camera and checks in automatically', async () => {
    stubMediaDevices(vi.fn().mockResolvedValue(fakeStream()));
    stubVideoAndCanvas();
    renderWithProviders(<AttendanceCheckIn />);

    // Wait for the real events to load so the scan targets evt-1.
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Field day' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Scan with camera' }));

    // The 4fps decode loop picks up the (mocked) QR payload and submits.
    await waitFor(
      () => {
        const call = fetchMock.mock.calls.find(([url, init]) =>
          String(url).includes(`/events/${EVENT.id}/attendance/scan`) &&
          (init as RequestInit)?.method === 'POST'
        );
        expect(call).toBeTruthy();
      },
      { timeout: 3000 }
    );
    const call = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes('/attendance/scan') && (init as RequestInit)?.method === 'POST'
    );
    expect(JSON.parse((call![1] as RequestInit).body as string).code).toBe('v1.event-abc123def');

    await waitFor(() => {
      expect(screen.getByText(/You are checked in/)).toBeTruthy();
    });
  });

  it('keeps the duplicate-scan 409 as a friendly reminder', async () => {
    stubMediaDevices(undefined);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/api/v1/chapters')) {
        return jsonResponse({ data: [CHAPTER], total: 1, page: 1, pageSize: 5 });
      }
      if (path.endsWith(`/api/v1/chapters/${CHAPTER.id}/events`)) {
        return jsonResponse({ data: [EVENT] });
      }
      if (path.endsWith(`/api/v1/events/${EVENT.id}/attendance/scan`)) {
        return jsonResponse(
          {
            statusCode: 409,
            error: 'Conflict',
            message: 'Already checked in',
            path,
            timestamp: '2026-03-01T00:00:00.000Z'
          },
          409
        );
      }
      return jsonResponse({ data: null });
    });

    renderWithProviders(<AttendanceCheckIn />);
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Field day' })).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Attendance code'), {
      target: { value: 'v1.event-duplicate' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check in' }));
    await waitFor(() => {
      expect(screen.getByTestId('duplicate-scan')).toBeTruthy();
    });
  });
});
