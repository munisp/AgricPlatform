import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationMessage } from '../src/api/types';
import { createInMemorySyncStore } from '../src/sync/store';
import { SyncContext, type SyncContextValue } from '../src/sync/context';
import { createInMemoryStorage } from '../src/offline/queue';
import { NotificationsScreen } from '../src/screens/NotificationsScreen';
import { ApiContext } from '../src/api/context';
import type { ApiClient } from '../src/api/client';

/**
 * NotificationsScreen sync integration (Wave SYNCCLIENT + GAP-M25):
 * opening the screen pulls the notification stream into the cache; marking
 * read goes through the offline mutation queue and re-syncs the cache.
 */

const unread: NotificationMessage = {
  id: 'notif-1',
  userId: 'user-1',
  channel: 'sms',
  title: 'Recall alert',
  body: 'A batch you purchased was recalled.',
  status: 'sent',
  createdAt: '2026-06-01T10:00:00.000Z'
};

function makeClient(): ApiClient {
  return {
    apiFetch: vi.fn(async (path: string, init: { method?: string } = {}) => {
      if (path === '/auth/session') {
        return { data: { user: { id: 'user-1', fullName: 'Aisha Bello', roles: ['farmer'] } } };
      }
      if (path.startsWith('/notifications')) {
        return { data: [unread] };
      }
      if (path === '/sync/pull') {
        return { data: { records: [], serverMaxChangeSeq: 7 } };
      }
      if (path === '/sync/push') {
        return { data: { results: [] } };
      }
      if (path.endsWith('/read') && init.method === 'POST') {
        return { data: { ...unread, status: 'read' } };
      }
      throw new Error(`unexpected fetch ${path}`);
    }) as ApiClient['apiFetch']
  } as unknown as ApiClient;
}

function renderScreen(client: ApiClient, store: SyncContextValue['store']) {
  const queue = require('../src/offline/queue').createOfflineQueue(createInMemoryStorage());
  return render(
    <ApiContext.Provider value={client}>
      <SyncContext.Provider value={{ store, status: { state: 'idle' }, refresh: vi.fn() }}>
        <NotificationsScreen queue={queue} />
      </SyncContext.Provider>
    </ApiContext.Provider>
  );
}

describe('NotificationsScreen sync integration', () => {
  let store: ReturnType<typeof createInMemorySyncStore>;
  let client: ApiClient;

  beforeEach(() => {
    store = createInMemorySyncStore();
    client = makeClient();
  });

  it('pulls the notification stream on open and renders cached records', async () => {
    renderScreen(client, store);
    await waitFor(() => expect(screen.getByText('Recall alert')).toBeTruthy());
    expect(client.apiFetch).toHaveBeenCalledWith(
      '/sync/pull',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('marking read enqueues the receipt, flushes it, and re-syncs the cache', async () => {
    renderScreen(client, store);
    const button = await screen.findByText('Mark read');
    fireEvent.press(button);
    await waitFor(() => {
      const calls = (client.apiFetch as ReturnType<typeof vi.fn>).mock.calls.map(
        ([path]: [string]) => path
      );
      expect(calls).toContain('/notifications/notif-1/read');
    });
    // The receipt flush re-synced the cache (the contract requires it).
    await waitFor(() => {
      const calls = (client.apiFetch as ReturnType<typeof vi.fn>).mock.calls.map(
        ([path]: [string]) => path
      );
      expect(calls.filter((path: string) => path === '/sync/pull').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('stays queued offline and flips the row optimistically', async () => {
    const offline = {
      apiFetch: vi.fn(async (path: string) => {
        if (path === '/auth/session') {
          return { data: { user: { id: 'user-1', fullName: 'Aisha Bello', roles: ['farmer'] } } };
        }
        if (path === '/sync/pull') {
          throw new TypeError('Network request failed');
        }
        throw new TypeError('Network request failed');
      })
    } as unknown as ApiClient;
    // Seed the cache so the screen has data while offline.
    await store.upsertRecord('notification', unread.id, unread, 1);
    renderScreen(offline, store);
    const button = await screen.findByText('Mark read');
    fireEvent.press(button);
    await waitFor(() =>
      expect(screen.getByText(/Saved offline/)).toBeTruthy()
    );
  });
});
