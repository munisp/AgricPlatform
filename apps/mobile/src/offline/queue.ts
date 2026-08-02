/**
 * Replayable offline mutation queue — the mobile counterpart of the web PWA
 * queue (apps/web/lib/offline-queue.ts).
 *
 * Mutations made while offline are appended to persistent storage with a
 * stable idempotency key; on reconnect `flush` replays them in order through
 * the API client. Successful entries are dropped, failed entries stay queued
 * for the next flush, so replays are safe (the API dedupes on the key).
 *
 * Storage backend: any AsyncStorage-compatible key/value store. Production
 * builds pass `@react-native-async-storage/async-storage` directly (its
 * getItem/setItem/removeItem signatures match `KeyValueStorage`); tests and
 * CI use the in-memory implementation below.
 */

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** In-memory KeyValueStorage fallback (see module note). */
export function createInMemoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    async getItem(key) {
      return map.get(key) ?? null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    }
  };
}

export interface QueuedRequest {
  id: string;
  /** Domain label for the outbox UI, e.g. 'services.booking.created'. */
  kind: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** API path relative to the base URL, e.g. '/service-offerings/o-1/bookings'. */
  path: string;
  payload?: unknown;
  idempotencyKey: string;
  enqueuedAt: string;
}

export interface FlushResult {
  sent: number;
  failed: number;
}

export type QueueSender = (request: QueuedRequest) => Promise<unknown>;

export interface OfflineQueue {
  enqueue(request: Omit<QueuedRequest, 'id' | 'enqueuedAt'>): Promise<QueuedRequest>;
  pending(): Promise<QueuedRequest[]>;
  clear(): Promise<void>;
  flush(sender: QueueSender): Promise<FlushResult>;
}

const STORAGE_KEY = 'nyfn.offline-queue.v1';

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createOfflineQueue(storage: KeyValueStorage): OfflineQueue {
  async function read(): Promise<QueuedRequest[]> {
    const raw = await storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as QueuedRequest[]) : [];
    } catch {
      return [];
    }
  }

  async function write(requests: QueuedRequest[]): Promise<void> {
    await storage.setItem(STORAGE_KEY, JSON.stringify(requests));
  }

  return {
    async enqueue(request) {
      const queued: QueuedRequest = {
        ...request,
        id: randomId(),
        enqueuedAt: new Date().toISOString()
      };
      const current = await read();
      await write([...current, queued]);
      return queued;
    },

    pending: read,

    async clear() {
      await write([]);
    },

    async flush(sender) {
      const remaining: QueuedRequest[] = [];
      let sent = 0;
      for (const request of await read()) {
        try {
          await sender(request);
          sent += 1;
        } catch {
          remaining.push(request);
        }
      }
      await write(remaining);
      return { sent, failed: remaining.length };
    }
  };
}
