'use client';

import type { ReactNode } from 'react';
import {
  ForbiddenError,
  NetworkError,
  RateLimitError,
  TimeoutError,
  UnauthorizedError
} from '@/lib/api/errors';
import { EmptyState } from '@/components/ui';

/**
 * Shared API state primitives — error mapping (401/403/429/offline/5xx),
 * offline-fallback notices and skeletons in the existing design language.
 */

export function ApiErrorNotice({
  error,
  onRetry
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  let title = 'Something went wrong';
  let hint = 'The request failed. Please try again.';

  if (error instanceof UnauthorizedError) {
    title = 'Sign in required';
    hint = 'Your session is missing or expired. Sign in again to continue.';
  } else if (error instanceof ForbiddenError) {
    title = 'No access';
    hint = 'Your account does not have permission to view this. Switch role or contact an admin.';
  } else if (error instanceof RateLimitError) {
    title = 'Slow down — throttled';
    hint =
      error.retryAfterSeconds !== undefined
        ? `Too many requests. Try again in about ${error.retryAfterSeconds}s.`
        : 'Too many requests. Please wait a moment and try again.';
  } else if (error instanceof NetworkError || error instanceof TimeoutError) {
    title = 'You appear to be offline';
    hint = 'The API is unreachable. Anything you submit is queued and syncs when you reconnect.';
  } else if (error instanceof Error && error.message) {
    hint = error.message;
  }

  return (
    <div className="empty" role="alert">
      <p style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{title}</p>
      <p className="small">{hint}</p>
      {onRetry ? (
        <p style={{ marginTop: '0.75rem', marginBottom: 0 }}>
          <button type="button" className="btn btn-ghost btn-small" onClick={onRetry}>
            Try again
          </button>
        </p>
      ) : null}
    </div>
  );
}

/** Shown above fixture data when the API is unreachable (source === 'fallback'). */
export function OfflineDataNotice({ children }: { children?: ReactNode }) {
  return (
    <p className="notice notice-info" role="status">
      {children ?? 'Offline — showing saved reference data. Live updates resume when you reconnect.'}
    </p>
  );
}

/** Shown when the API returned live data while a background refresh runs. */
export function RefreshingNotice() {
  return (
    <p className="small muted" role="status" aria-live="polite">
      Refreshing…
    </p>
  );
}

export function SkeletonBlock({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card" aria-hidden="true" data-testid="skeleton">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="skeleton-line"
          style={{ width: i === 0 ? '45%' : i === lines - 1 ? '70%' : '90%' }}
        />
      ))}
    </div>
  );
}

export function QueryState({
  isLoading,
  error,
  data,
  onRetry,
  empty,
  skeletonLines = 3,
  children
}: {
  isLoading: boolean;
  error: unknown;
  /** Considered "present" when not undefined and (for arrays) not empty. */
  data: unknown;
  onRetry?: () => void;
  /** Empty-state content when data is present but empty. */
  empty?: ReactNode;
  skeletonLines?: number;
  children: ReactNode;
}) {
  const hasData =
    data !== undefined && (!Array.isArray(data) || data.length > 0);

  if (hasData) return <>{children}</>;
  if (isLoading) return <SkeletonBlock lines={skeletonLines} />;
  if (error) {
    // Data-less error (no cache, no fallback): show the mapped state.
    if (Array.isArray(data) || data === undefined) {
      return <ApiErrorNotice error={error} onRetry={onRetry} />;
    }
  }
  return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
}
