'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { NetworkError, TimeoutError } from './errors';
import { useAppState } from '@/lib/app-state';
import type { QueuedChainStep } from '@/lib/offline-queue';

/**
 * Minimal SWR-style data hooks with no new dependencies.
 *
 * `useApiQuery` serves a module-level in-memory cache instantly, revalidates
 * in the background, and falls back to caller-provided fixture data when the
 * API is unreachable (offline-first PWA requirement).
 *
 * `useApiMutation` runs mutations through the typed client and can hand them
 * to the replayable offline queue when the network is down.
 */

interface CacheEntry<T> {
  data: T;
  updatedAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

/** Test hook: clear the in-memory query cache. */
export function clearApiCache(): void {
  cache.clear();
}

/** Drop specific cache keys so the next `useApiQuery` mount revalidates (e.g. after a mutation). */
export function invalidateApiQueries(...keys: string[]): void {
  for (const key of keys) {
    cache.delete(key);
  }
}

export type QuerySource = 'api' | 'cache' | 'fallback';

export interface UseApiQueryResult<T> {
  data: T | undefined;
  error: unknown;
  /** True only on the very first load (no cached/fallback data yet). */
  isLoading: boolean;
  /** True while a background revalidation is in flight. */
  isValidating: boolean;
  /** Where the currently displayed data came from. */
  source: QuerySource;
  refresh: () => void;
}

export interface UseApiQueryOptions<T> {
  /**
   * Fixture data shown when the API is unreachable and nothing is cached.
   * Clearly a placeholder — `source === 'fallback'` tells the UI to say so.
   */
  fallbackData?: T;
  /** How long cached data is considered fresh (default 30s). */
  staleTimeMs?: number;
  /** Set false to pause fetching (e.g. waiting for hydration). */
  enabled?: boolean;
}

export function useApiQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: UseApiQueryOptions<T> = {}
): UseApiQueryResult<T> {
  const { fallbackData, staleTimeMs = 30_000, enabled = true } = options;
  const cached = key ? (cache.get(key) as CacheEntry<T> | undefined) : undefined;

  // Fixture data is NOT seeded up-front: on a normal online load the UI must
  // show a loading/skeleton state, not flash fixtures with a false "live data
  // unavailable" notice. `fallbackData` only becomes the visible data after
  // an actual fetch failure (source === 'fallback').
  const [data, setData] = useState<T | undefined>(cached?.data);
  const [error, setError] = useState<unknown>(undefined);
  const [isValidating, setIsValidating] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(Boolean(cached));
  const [source, setSource] = useState<QuerySource>(cached ? 'cache' : 'api');
  const [refreshCount, setRefreshCount] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const fallbackRef = useRef(fallbackData);
  fallbackRef.current = fallbackData;

  useEffect(() => {
    if (!key || !enabled) return;
    let cancelled = false;
    const entry = cache.get(key) as CacheEntry<T> | undefined;
    const fresh = entry && Date.now() - entry.updatedAt < staleTimeMs;

    if (entry) {
      setData(entry.data);
      setSource('cache');
      setHasLoaded(true);
      if (fresh) return; // serve fresh cache without revalidating
    } else {
      setIsValidating(true);
    }

    fetcherRef
      .current()
      .then((result) => {
        if (cancelled) return;
        cache.set(key, { data: result, updatedAt: Date.now() });
        setData(result);
        setSource('api');
        setError(undefined);
        setHasLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err);
        const stale = cache.get(key) as CacheEntry<T> | undefined;
        if (stale) {
          setData(stale.data);
          setSource('cache');
          setHasLoaded(true);
        } else if (fallbackRef.current !== undefined) {
          setData(fallbackRef.current);
          setSource('fallback');
        }
      })
      .finally(() => {
        if (!cancelled) setIsValidating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [key, enabled, staleTimeMs, refreshCount]);

  const refresh = useCallback(() => {
    if (key) cache.delete(key);
    setRefreshCount((count) => count + 1);
  }, [key]);

  return {
    data,
    error,
    isLoading: !hasLoaded && data === undefined && !error,
    isValidating,
    source,
    refresh
  };
}

export type MutationStatus = 'idle' | 'pending' | 'queued' | 'success' | 'error';

export interface UseApiMutationOptions<TInput, TResult> {
  /** Perform the mutation (usually an endpoints.ts wrapper). */
  mutationFn: (input: TInput) => Promise<TResult>;
  /** When set, network failures queue the mutation for replay. */
  queue?: {
    kind: string;
    label: (input: TInput) => string;
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: (input: TInput) => string;
    payload?: (input: TInput) => unknown;
    /**
     * Compound-mutation follow-ups replayed after the primary request during
     * a queue flush (e.g. credit draft → submit). `{id}` in a step path is
     * substituted from the primary response's `data.id`.
     */
    chain?: (input: TInput) => QueuedChainStep[];
  };
  onSuccess?: (result: TResult, input: TInput) => void;
  onQueued?: (input: TInput) => void;
  /** Called with the failure when the mutation errors (not when queued). */
  onError?: (error: unknown, input: TInput) => void;
}

export interface UseApiMutationResult<TInput, TResult> {
  mutate: (input: TInput) => Promise<TResult | undefined>;
  status: MutationStatus;
  error: unknown;
  data: TResult | undefined;
  reset: () => void;
}

export function useApiMutation<TInput, TResult>(
  options: UseApiMutationOptions<TInput, TResult>
): UseApiMutationResult<TInput, TResult> {
  const { enqueue } = useAppState();
  const [status, setStatus] = useState<MutationStatus>('idle');
  const [error, setError] = useState<unknown>(undefined);
  const [data, setData] = useState<TResult | undefined>(undefined);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const mutate = useCallback(
    async (input: TInput): Promise<TResult | undefined> => {
      const opts = optionsRef.current;
      setStatus('pending');
      setError(undefined);

      const queueIt = () => {
        if (!opts.queue) return false;
        enqueue({
          kind: opts.queue.kind,
          label: opts.queue.label(input),
          method: opts.queue.method,
          path: opts.queue.path(input),
          payload: opts.queue.payload ? opts.queue.payload(input) : input,
          chain: opts.queue.chain ? opts.queue.chain(input) : undefined
        });
        setStatus('queued');
        opts.onQueued?.(input);
        return true;
      };

      if (typeof navigator !== 'undefined' && navigator.onLine === false && opts.queue) {
        queueIt();
        return undefined;
      }

      try {
        const result = await opts.mutationFn(input);
        setData(result);
        setStatus('success');
        opts.onSuccess?.(result, input);
        return result;
      } catch (err: unknown) {
        // Offline-first: network/timeout failures on queueable mutations are
        // parked in the sync queue instead of being lost.
        if ((err instanceof NetworkError || err instanceof TimeoutError) && queueIt()) {
          return undefined;
        }
        setError(err);
        setStatus('error');
        opts.onError?.(err, input);
        return undefined;
      }
    },
    [enqueue]
  );

  const reset = useCallback(() => {
    setStatus('idle');
    setError(undefined);
    setData(undefined);
  }, []);

  return { mutate, status, error, data, reset };
}
