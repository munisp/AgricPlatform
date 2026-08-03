/**
 * Durable storage tests (audit P0-4/P1-5): the offline queue and the
 * record-level sync store survive "app restarts" (re-instantiation over the
 * same AsyncStorage) with cursors, outbox and queued mutations intact.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createOfflineQueue } from '../src/offline/queue';
import { createSyncStore, type SyncTransport } from '../src/sync/store';

function emptyTransport(): SyncTransport {
  return {
    async push() {
      return { results: [] };
    },
    async pull({ entity }) {
      return { entity, items: [], cursor: 0, hasMore: false };
    },
    async status() {
      return [];
    }
  };
}

describe('durable AsyncStorage persistence (restart simulation)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('keeps queued offline mutations across queue re-creation', async () => {
    const queue = createOfflineQueue(AsyncStorage);
    await queue.enqueue({
      kind: 'farms.plot.created',
      method: 'POST',
      path: '/farms/plots',
      payload: { name: 'Restart Plot' },
      idempotencyKey: 'farms.plot.restart'
    });

    // "Restart": a brand-new queue over the same storage sees the entry.
    const afterRestart = createOfflineQueue(AsyncStorage);
    const pending = await afterRestart.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].idempotencyKey).toBe('farms.plot.restart');

    // And the entry can still be flushed after the restart.
    const result = await afterRestart.flush(async () => ({}));
    expect(result.sent).toBe(1);
    expect(await afterRestart.pending()).toHaveLength(0);
  });

  it('keeps the sync cursor and records across store re-creation', async () => {
    const transport: SyncTransport = {
      ...emptyTransport(),
      async pull({ entity, since }) {
        if (since > 0) return { entity, items: [], cursor: since, hasMore: false };
        return {
          entity,
          items: [
            { entityId: 'n-1', version: 7, deleted: false, payload: { id: 'n-1', title: 'Hello' } }
          ],
          cursor: 7,
          hasMore: false
        };
      }
    };
    const store = createSyncStore({ storage: AsyncStorage, transport });
    const summary = await store.pullEntity('notification');
    expect(summary.cursor).toBe(7);

    // "Restart": new store over the same storage resumes at the cursor and
    // still serves the cached records (offline re-open).
    const afterRestart = createSyncStore({ storage: AsyncStorage, transport: emptyTransport() });
    await afterRestart.hydrate();
    expect(afterRestart.getCursor('notification')).toBe(7);
    expect(afterRestart.getRecords('notification')).toHaveLength(1);
  });

  it('keeps the record-level outbox across store re-creation', async () => {
    const store = createSyncStore({ storage: AsyncStorage, transport: emptyTransport() });
    await store.enqueue({
      entity: 'notification',
      entityId: 'n-1',
      op: 'upsert',
      payload: { title: 'queued' },
      clientMutationId: 'mut-restart'
    });

    const afterRestart = createSyncStore({ storage: AsyncStorage, transport: emptyTransport() });
    await afterRestart.hydrate();
    expect(afterRestart.getOutbox()).toHaveLength(1);
    expect(afterRestart.getOutbox()[0].clientMutationId).toBe('mut-restart');
  });
});
