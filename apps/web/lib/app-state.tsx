'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { UserRole } from '@agric-platform/shared';
import { apiFetch } from '@/lib/api/client';
import {
  createQueueItem,
  flushQueue,
  normalizeQueueItem
} from '@/lib/offline-queue';
import type { EnqueueInput, QueuedSubmission } from '@/lib/offline-queue';
import { SessionProvider, useSession } from '@/lib/session';

export type { QueuedSubmission } from '@/lib/offline-queue';

interface AppStateValue {
  hydrated: boolean;
  role: UserRole;
  setRole: (role: UserRole) => void;
  userId: string;
  queue: QueuedSubmission[];
  enqueue: (input: EnqueueInput) => QueuedSubmission;
  /** Flush all pending items now (also triggered by `online` + interval). */
  syncQueue: () => Promise<void>;
  /** Re-queue a single failed/sent item and flush. */
  retryItem: (id: string) => Promise<void>;
  clearQueue: () => void;
}

const QUEUE_KEY = 'agric.queue';
const FLUSH_INTERVAL_MS = 30_000;

const AppStateContext = createContext<AppStateValue | null>(null);

function readStoredQueue(): QueuedSubmission[] {
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizeQueueItem(item))
      .filter((item): item is QueuedSubmission => item !== null);
  } catch {
    return [];
  }
}

function writeQueue(items: QueuedSubmission[]): void {
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  } catch {
    // Storage full or unavailable — the app degrades silently.
  }
}

/** Replays a queued mutation against the API with its stored idempotency key. */
async function sendQueuedItem(item: QueuedSubmission): Promise<void> {
  const primary = await apiFetch<{ data?: { id?: unknown } }>(item.path, {
    method: item.method,
    body: item.payload,
    idempotencyKey: item.idempotencyKey
  });
  // Compound mutations (e.g. credit draft → submit): replay the follow-up
  // steps against the id the primary request returned. Derived idempotency
  // keys keep retries of a half-finished chain safe — the primary replays
  // its stored response for the same key, yielding the same id.
  if (item.chain && item.chain.length > 0) {
    const id = primary?.data?.id;
    if (typeof id !== 'string' || id === '') {
      throw new Error('Queued follow-up could not resolve the primary record id');
    }
    for (const [index, step] of item.chain.entries()) {
      await apiFetch(step.path.replaceAll('{id}', encodeURIComponent(id)), {
        method: step.method,
        body: step.payload,
        idempotencyKey: `${item.idempotencyKey}-chain-${index}`
      });
    }
  }
}

function QueueProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const [queue, setQueue] = useState<QueuedSubmission[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const flushingRef = useRef(false);

  useEffect(() => {
    setQueue(readStoredQueue());
    setHydrated(true);
  }, []);

  const updateQueue = useCallback((next: QueuedSubmission[]) => {
    setQueue(next);
    writeQueue(next);
  }, []);

  const enqueue = useCallback(
    (input: EnqueueInput) => {
      const submission = createQueueItem(input);
      setQueue((current) => {
        const next = [...current, submission];
        writeQueue(next);
        return next;
      });
      return submission;
    },
    []
  );

  const syncQueue = useCallback(async () => {
    if (flushingRef.current) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    flushingRef.current = true;
    try {
      const next = await flushQueue(queue, sendQueuedItem);
      updateQueue(next);
    } finally {
      flushingRef.current = false;
    }
  }, [queue, updateQueue]);

  const retryItem = useCallback(
    async (id: string) => {
      const reset = queue.map((item) =>
        item.id === id && item.status !== 'sending' && item.path
          ? { ...item, status: 'queued' as const, lastError: undefined }
          : item
      );
      updateQueue(reset);
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (flushingRef.current) return;
      flushingRef.current = true;
      try {
        const next = await flushQueue(reset, sendQueuedItem);
        updateQueue(next);
      } finally {
        flushingRef.current = false;
      }
    },
    [queue, updateQueue]
  );

  const clearQueue = useCallback(() => {
    updateQueue([]);
  }, [updateQueue]);

  // Flush on reconnect and on a slow interval while the app is open.
  const syncRef = useRef(syncQueue);
  syncRef.current = syncQueue;
  useEffect(() => {
    const onOnline = () => void syncRef.current();
    window.addEventListener('online', onOnline);
    const interval = window.setInterval(onOnline, FLUSH_INTERVAL_MS);
    return () => {
      window.removeEventListener('online', onOnline);
      window.clearInterval(interval);
    };
  }, []);

  const value = useMemo<AppStateValue>(
    () => ({
      hydrated,
      role: session.role,
      setRole: session.previewRole,
      userId: session.userId,
      queue,
      enqueue,
      syncQueue,
      retryItem,
      clearQueue
    }),
    [hydrated, session.role, session.previewRole, session.userId, queue, enqueue, syncQueue, retryItem, clearQueue]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <QueueProvider>{children}</QueueProvider>
    </SessionProvider>
  );
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error('useAppState must be used within <AppProvider>');
  }
  return ctx;
}
