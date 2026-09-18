/**
 * Replayable offline mutation queue — the mobile counterpart of the web PWA
 * queue (apps/web/lib/offline-queue.ts).
 *
 * Mutations made while offline are appended to persistent storage with a
 * stable idempotency key; on reconnect `flush` replays them in FIFO order
 * through the API client. Successful entries are dropped, failed entries
 * stay queued for the next flush, so replays are safe (the API dedupes on
 * the key). Enqueueing the same idempotency key twice is a no-op — the
 * existing entry is returned, so a double-tap cannot queue two copies of
 * one logical mutation.
 *
 * Auth-failure park: when a replay rejects with a 401 the session is dead
 * and every remaining replay would fail too (and could trip server-side
 * idempotency/rate limits). The flush stops immediately and parks the
 * current and all later entries for the next flush after re-login.
 *
 * Staleness & ordering (V-64):
 * - Every entry carries `enqueuedAt`; entries older than their kind's TTL
 *   are EXPIRED, not replayed — a month-old sale must not apply month-old
 *   prices as current truth. Expired entries drop out of the queue and are
 *   surfaced in the flush result (and via `expired()` for the outbox UI).
 * - Stop-on-error per chain: when a replay fails, later entries sharing the
 *   failed entry's explicit `chainKey` are blocked for this flush — a
 *   dependent mutation never replays against a parent whose own replay
 *   just failed. Blocked entries stay queued for the next flush. Entries
 *   without a chainKey are independent and never block each other.
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
  /**
   * Dependency chain for stop-on-error ordering (V-64): entries that must
   * not replay after a sibling failed share a chain key, e.g.
   * `farm_plot:plot-1` for a create→update chain on one record. Omit it for
   * independent mutations — chains are opt-in.
   */
  chainKey?: string;
}

export interface FlushResult {
  sent: number;
  failed: number;
  /** Entries not attempted because a replay failed with 401 (auth park). */
  parked: number;
  /** Entries not attempted because an earlier entry in their chain failed. */
  blocked: number;
  /** Expired entries dropped WITHOUT replaying (surface them in the UI). */
  expired: QueuedRequest[];
}

export type QueueSender = (request: QueuedRequest) => Promise<unknown>;

export interface OfflineQueue {
  enqueue(request: Omit<QueuedRequest, 'id' | 'enqueuedAt'>): Promise<QueuedRequest>;
  pending(): Promise<QueuedRequest[]>;
  /** Currently-queued entries past their TTL (outbox UI surfacing; V-64). */
  expired(): Promise<QueuedRequest[]>;
  clear(): Promise<void>;
  flush(sender: QueueSender): Promise<FlushResult>;
}

/** Default staleness window for queued mutations (7 days). */
export const DEFAULT_OFFLINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-kind TTL overrides (V-64): price/availability-bearing mutations age
 * out fast — replaying them late applies stale terms as current truth.
 */
export const OFFLINE_KIND_TTL_MS: Record<string, number> = {
  'services.booking.created': 24 * 60 * 60 * 1000,
  'marketplace.order.created': 24 * 60 * 60 * 1000
};

export interface OfflineQueueOptions {
  /** Fallback TTL for kinds without an override (default 7 days). */
  defaultTtlMs?: number;
  /** Per-kind TTL overrides (merged over OFFLINE_KIND_TTL_MS). */
  kindTtlMs?: Record<string, number>;
  /** Clock seam for tests. */
  now?: () => Date;
}

const STORAGE_KEY = 'nyfn.offline-queue.v1';

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Duck-typed 401 check — the queue must not depend on the API client. */
export function isAuthFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: unknown }).status === 401
  );
}

/**
 * Chain identity for stop-on-error ordering (V-64). Chains are OPT-IN: an
 * entry without an explicit chainKey is independent — a sibling's failure
 * never blocks it (same-kind mutations are usually unrelated records).
 */
function chainOf(request: QueuedRequest): string | undefined {
  return request.chainKey;
}

export function createOfflineQueue(
  storage: KeyValueStorage,
  options: OfflineQueueOptions = {}
): OfflineQueue {
  const now = options.now ?? (() => new Date());
  const kindTtl: Record<string, number> = { ...OFFLINE_KIND_TTL_MS, ...options.kindTtlMs };
  const defaultTtl = options.defaultTtlMs ?? DEFAULT_OFFLINE_TTL_MS;

  function ttlFor(kind: string): number {
    return kindTtl[kind] ?? defaultTtl;
  }

  function isExpired(request: QueuedRequest): boolean {
    const enqueued = Date.parse(request.enqueuedAt);
    if (Number.isNaN(enqueued)) {
      return false; // unparseable timestamp: replay rather than drop silently
    }
    return now().getTime() - enqueued > ttlFor(request.kind);
  }
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
      const current = await read();
      // Dedup by idempotency key: one logical mutation, one queue entry.
      const existing = current.find((entry) => entry.idempotencyKey === request.idempotencyKey);
      if (existing) return existing;

      const queued: QueuedRequest = {
        ...request,
        id: randomId(),
        enqueuedAt: now().toISOString()
      };
      await write([...current, queued]);
      return queued;
    },

    pending: read,

    async expired() {
      return (await read()).filter(isExpired);
    },

    async clear() {
      await write([]);
    },

    async flush(sender) {
      const remaining: QueuedRequest[] = [];
      const expiredEntries: QueuedRequest[] = [];
      const failedChains = new Set<string>();
      let sent = 0;
      let parked = 0;
      let blocked = 0;
      let authParked = false;
      for (const request of await read()) {
        if (authParked) {
          // Behind a 401: leave everything queued in original order.
          remaining.push(request);
          parked += 1;
          continue;
        }
        if (isExpired(request)) {
          // Stale mutation (V-64): never replayed — surface it instead of
          // applying aged prices/availability as current truth.
          expiredEntries.push(request);
          continue;
        }
        const chain = chainOf(request);
        if (chain !== undefined && failedChains.has(chain)) {
          // An earlier entry in this chain failed: dependents wait for the
          // next flush instead of replaying against a missing parent.
          remaining.push(request);
          blocked += 1;
          continue;
        }
        try {
          await sender(request);
          sent += 1;
        } catch (error) {
          remaining.push(request);
          if (chain !== undefined) {
            failedChains.add(chain);
          }
          if (isAuthFailure(error)) {
            // Session is dead — park this and every later entry unattempted.
            authParked = true;
            parked += 1;
          }
        }
      }
      await write(remaining);
      return {
        sent,
        failed: remaining.length - parked - blocked,
        parked,
        blocked,
        expired: expiredEntries
      };
    }
  };
}
