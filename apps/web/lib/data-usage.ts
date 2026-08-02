'use client';

import { useEffect } from 'react';
import { usePersistentState } from '@/lib/use-persistent-state';

/**
 * Session data-usage estimate (Appendix F Phase-1): sums transferSize across
 * PerformanceResourceTiming entries (navigation + subresources since load).
 * This is an estimate for transparency, not metering — it resets per session
 * and excludes anything fetched before performance observer support or
 * cross-origin responses without Timing-Allow-Origin (transferSize 0).
 */
export function getSessionDataUsageBytes(): number {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
    return 0;
  }
  let total = 0;
  for (const entry of performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]) {
    total += entry.transferSize || 0;
  }
  for (const entry of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
    total += entry.transferSize || 0;
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const REDUCE_DATA_KEY = 'agric.reduce-data';

/**
 * "Reduce data usage" preference. Phase 1 scope (documented in the settings
 * UI): sets `data-reduce-data` on <html> and is read by media surfaces to
 * defer non-essential downloads — podcast audio already ships with
 * preload="none", and offscreen images lazy-load. It does NOT change API
 * payload sizes (server-side negotiation lands in a later wave).
 */
export function useReduceData(): readonly [boolean, (value: boolean) => void, boolean] {
  const [enabled, setEnabled, hydrated] = usePersistentState<boolean>(REDUCE_DATA_KEY, false);

  useEffect(() => {
    if (!hydrated || typeof document === 'undefined') return;
    if (enabled) {
      document.documentElement.dataset.reduceData = 'on';
    } else {
      delete document.documentElement.dataset.reduceData;
    }
  }, [enabled, hydrated]);

  return [enabled, setEnabled, hydrated] as const;
}
