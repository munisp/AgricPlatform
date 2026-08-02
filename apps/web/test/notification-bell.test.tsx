import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { NotificationBell } from '@/components/notification-bell';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

function renderBell() {
  return render(
    <AppProvider>
      <I18nProvider>
        <NotificationBell />
      </I18nProvider>
    </AppProvider>
  );
}

const UNREAD = {
  id: 'n-1',
  userId: 'user-adamu',
  channel: 'in_app',
  title: 'Rain expected',
  body: 'Planting window opens this week.',
  status: 'sent',
  createdAt: '2026-06-01T00:00:00.000Z'
};

/** Minimal EventSource double capturing instances for assertions. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  push(payload: unknown) {
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  fail() {
    this.onerror?.();
  }
}

describe('NotificationBell (Wave P)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    clearApiCache();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows unread count from the polling query and lists alerts', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/feature-flags/')) {
        return jsonResponse({ data: { key: 'notifications.sse', enabled: false } });
      }
      return jsonResponse({ data: [UNREAD] });
    });
    renderBell();
    const badge = await screen.findByTestId('bell-badge');
    expect(badge.textContent).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: /open notifications/i }));
    expect(screen.getByText('Rain expected')).toBeTruthy();
    expect(screen.getByTestId('bell-mode').textContent).toMatch(/30 seconds/);
  });

  it('opens an SSE stream when the flag is enabled and applies pushes live', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/feature-flags/')) {
        return jsonResponse({ data: { key: 'notifications.sse', enabled: true } });
      }
      return jsonResponse({ data: [] });
    });
    renderBell();
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const source = FakeEventSource.instances[0];
    expect(source.url).toContain('/notifications/stream');
    expect(source.url).toContain('x-user-id=');

    source.push({ unreadCount: 2, notifications: [UNREAD, { ...UNREAD, id: 'n-2' }], emittedAt: '2026-06-01T01:00:00.000Z' });
    await waitFor(() => expect(screen.getByTestId('bell-badge').textContent).toBe('2'));
    fireEvent.click(screen.getByRole('button', { name: /open notifications/i }));
    expect(screen.getByTestId('bell-mode').textContent).toMatch(/live/i);
  });

  it('falls back to polling when the stream errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/feature-flags/')) {
        return jsonResponse({ data: { key: 'notifications.sse', enabled: true } });
      }
      return jsonResponse({ data: [UNREAD] });
    });
    renderBell();
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    FakeEventSource.instances[0].fail();
    const badge = await screen.findByTestId('bell-badge');
    expect(badge.textContent).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: /open notifications/i }));
    expect(screen.getByTestId('bell-mode').textContent).toMatch(/30 seconds/);
  });

  it('stays on polling when flag evaluation fails (offline)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/feature-flags/')) {
        return Promise.reject(new Error('offline'));
      }
      return jsonResponse({ data: [UNREAD] });
    });
    renderBell();
    const badge = await screen.findByTestId('bell-badge');
    expect(badge.textContent).toBe('1');
    expect(FakeEventSource.instances.length).toBe(0);
  });
});
