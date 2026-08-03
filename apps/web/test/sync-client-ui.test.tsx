import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { NotificationBell } from '@/components/notification-bell';
import { SyncBadge } from '@/components/sync-badge';
import { setSharedSyncStore } from '@/lib/sync/react';
import { createSyncStore, type SyncStore, type SyncTransport } from '@/lib/sync/store';
import { createInMemoryStorage } from '@/lib/sync/storage';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
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

function renderBell() {
  return render(
    <AppProvider>
      <I18nProvider>
        <NotificationBell />
      </I18nProvider>
    </AppProvider>
  );
}

/** Store pre-seeded with one cached notification; pulls recorded. */
async function seededStore() {
  const pullCalls: Array<{ entity: string; since: number; limit: number }> = [];
  const transport: SyncTransport = {
    pull: async (params) => {
      pullCalls.push(params);
      return {
        entity: params.entity,
        items:
          params.since === 0 && params.entity === 'notification'
            ? [{ entityId: 'n-1', version: 1, deleted: false, payload: UNREAD }]
            : [],
        cursor: params.since === 0 ? 1 : params.since,
        hasMore: false
      };
    },
    push: async () => ({ results: [] }),
    status: async () => []
  };
  const store = createSyncStore({ storage: createInMemoryStorage(), transport });
  await store.pullEntity('notification');
  pullCalls.length = 0;
  return { store, pullCalls, transport };
}

describe('NotificationBell — sync cache fallback (Wave SYNCCLIENT)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    clearApiCache();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setSharedSyncStore(null);
  });

  it('serves the last synced cache with an offline mode line when the API is unreachable', async () => {
    const { store } = await seededStore();
    setSharedSyncStore(store);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/feature-flags/')) {
        return jsonResponse({ data: { key: 'notifications.sse', enabled: false } });
      }
      return Promise.reject(new Error('offline'));
    });

    renderBell();
    const badge = await screen.findByTestId('bell-badge');
    expect(badge.textContent).toBe('1'); // unread from the sync cache
    fireEvent.click(screen.getByRole('button', { name: /open notifications/i }));
    expect(screen.getByText('Rain expected')).toBeTruthy();
    expect(screen.getByTestId('bell-mode').textContent).toMatch(/last synced alerts/i);
  });

  it('keeps the normal polling mode when the API is reachable', async () => {
    const { store } = await seededStore();
    setSharedSyncStore(store);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/feature-flags/')) {
        return jsonResponse({ data: { key: 'notifications.sse', enabled: false } });
      }
      return jsonResponse({ data: [UNREAD] });
    });

    renderBell();
    await screen.findByTestId('bell-badge');
    fireEvent.click(screen.getByRole('button', { name: /open notifications/i }));
    expect(screen.getByTestId('bell-mode').textContent).toMatch(/30 seconds/);
  });

  it('opening the panel is an explicit sync point (pulls the notification entity)', async () => {
    const { store, pullCalls } = await seededStore();
    setSharedSyncStore(store);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/feature-flags/')) {
        return jsonResponse({ data: { key: 'notifications.sse', enabled: false } });
      }
      return jsonResponse({ data: [] });
    });

    renderBell();
    fireEvent.click(screen.getByRole('button', { name: /open notifications/i }));
    await waitFor(() => expect(pullCalls.length).toBeGreaterThan(0));
    expect(pullCalls[0]).toMatchObject({ entity: 'notification', since: 1 });
  });
});

describe('SyncBadge (Wave SYNCCLIENT)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    setSharedSyncStore(null);
  });

  function conflictedStore(): SyncStore {
    const transport: SyncTransport = {
      pull: async (params) => ({ entity: params.entity, items: [], cursor: params.since, hasMore: false }),
      push: async (items) => ({
        results: items.map((item) => ({
          entity: item.entity,
          entityId: item.entityId,
          clientMutationId: item.clientMutationId,
          status: 'conflict' as const,
          serverVersion: 4,
          serverPayload: { name: 'Server' }
        }))
      }),
      status: async () => []
    };
    return createSyncStore({ storage: createInMemoryStorage(), transport });
  }

  it('shows pending and conflict counts, then Synced after an explicit sync', async () => {
    const store = conflictedStore();
    setSharedSyncStore(store);
    // One conflict (resolved server-wins) + two still-pending mutations.
    await store.enqueue({ entity: 'farm', entityId: 'f-0', op: 'upsert', payload: { name: 'x' } });
    await store.pushPending();
    await store.enqueue({ entity: 'farm', entityId: 'f-1', op: 'upsert', payload: { name: 'a' } });
    await store.enqueue({ entity: 'farm', entityId: 'f-2', op: 'upsert', payload: { name: 'b' } });

    render(
      <I18nProvider>
        <SyncBadge />
      </I18nProvider>
    );
    expect(screen.getByTestId('sync-badge').textContent).toBe('Pending 2 · Conflicts resolved 1');

    // f-1/f-2 also conflict (server-wins), pulls succeed → clean pass.
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() =>
      expect(screen.getByTestId('sync-badge').textContent).toBe('Synced · Conflicts resolved 3')
    );
  });

  it('shows Not synced yet before any successful pass', async () => {
    setSharedSyncStore(conflictedStore());
    render(
      <I18nProvider>
        <SyncBadge />
      </I18nProvider>
    );
    expect(screen.getByTestId('sync-badge').textContent).toBe('Not synced yet');
  });
});
