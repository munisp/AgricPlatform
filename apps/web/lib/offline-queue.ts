/**
 * Replayable offline mutation queue.
 *
 * Items carry everything needed to replay an API mutation (method, path,
 * payload) plus the idempotency key captured at enqueue time, so a flush
 * after connectivity returns replays safely — the API replays the stored
 * response for a repeated `Idempotency-Key`.
 *
 * This module is pure/stateless so it can be unit-tested without React;
 * `app-state.tsx` owns persistence and scheduling.
 */
export type QueueStatus = 'queued' | 'sending' | 'sent' | 'failed';

export interface QueuedSubmission {
  id: string;
  /** Short machine kind for grouping/analytics, e.g. 'order.place'. */
  kind: string;
  /** Human label shown in the sync queue UI. */
  label: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** API path relative to the base URL, e.g. '/listings/abc/orders'. */
  path: string;
  payload?: unknown;
  idempotencyKey: string;
  createdAt: string;
  status: QueueStatus;
  attempts: number;
  lastError?: string;
}

export interface EnqueueInput {
  kind: string;
  label: string;
  method: QueuedSubmission['method'];
  path: string;
  payload?: unknown;
  id?: string;
  idempotencyKey?: string;
  createdAt?: string;
}

function randomKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createQueueItem(input: EnqueueInput): QueuedSubmission {
  return {
    id: input.id ?? `queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: input.kind,
    label: input.label,
    method: input.method,
    path: input.path,
    payload: input.payload,
    idempotencyKey: input.idempotencyKey ?? randomKey(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    status: 'queued',
    attempts: 0
  };
}

/** Migrate legacy display-only queue entries (`{kind,label,status:'queued'}`). */
export function normalizeQueueItem(raw: unknown): QueuedSubmission | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.label !== 'string') return null;
  if (
    typeof record.method === 'string' &&
    typeof record.path === 'string' &&
    typeof record.idempotencyKey === 'string'
  ) {
    const status = record.status;
    return {
      ...(record as unknown as QueuedSubmission),
      status:
        status === 'sent' || status === 'failed' || status === 'sending' || status === 'queued'
          ? // Never resurrect a mid-flight 'sending' from storage.
            status === 'sending'
            ? 'queued'
            : status
          : 'queued',
      attempts: typeof record.attempts === 'number' ? record.attempts : 0
    };
  }
  // Legacy item without replay info — keep it visible but marked failed.
  return {
    id: record.id,
    kind: typeof record.kind === 'string' ? record.kind : 'legacy',
    label: record.label,
    method: 'POST',
    path: '',
    idempotencyKey: randomKey(),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
    status: 'failed',
    attempts: 0,
    lastError: 'Recorded by an earlier app version; please resubmit.'
  };
}

export function markSending(items: QueuedSubmission[], id: string): QueuedSubmission[] {
  return items.map((item) => (item.id === id ? { ...item, status: 'sending' } : item));
}

export function markSent(items: QueuedSubmission[], id: string): QueuedSubmission[] {
  return items.map((item) =>
    item.id === id ? { ...item, status: 'sent', attempts: item.attempts + 1, lastError: undefined } : item
  );
}

export function markFailed(items: QueuedSubmission[], id: string, error: string): QueuedSubmission[] {
  return items.map((item) =>
    item.id === id
      ? { ...item, status: 'failed', attempts: item.attempts + 1, lastError: error }
      : item
  );
}

/**
 * Flush every queued/failed item through `send`, sequentially, in creation
 * order. `send` resolves on success and rejects on failure; the returned
 * array reflects the resulting statuses. Items already `sent` are kept as-is.
 */
export async function flushQueue(
  items: QueuedSubmission[],
  send: (item: QueuedSubmission) => Promise<void>
): Promise<QueuedSubmission[]> {
  let current = items;
  for (const item of items) {
    if (item.status === 'sent' || item.status === 'sending') continue;
    if (!item.path) continue; // legacy items are not replayable
    current = markSending(current, item.id);
    try {
      await send(item);
      current = markSent(current, item.id);
    } catch (error) {
      current = markFailed(
        current,
        item.id,
        error instanceof Error ? error.message : 'Sync failed'
      );
    }
  }
  return current;
}

/** Sender used in production: replays the stored mutation via the API client. */
export type QueueSender = (item: QueuedSubmission) => Promise<void>;
