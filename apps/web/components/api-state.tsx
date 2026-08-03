'use client';

import type { ReactNode } from 'react';
import {
  ForbiddenError,
  NetworkError,
  RateLimitError,
  TimeoutError,
  UnauthorizedError
} from '@/lib/api/errors';
import { useT } from '@/lib/i18n';
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
  const { t } = useT();
  let title = t('apiState.errorTitle');
  let hint = t('apiState.errorHint');

  if (error instanceof UnauthorizedError) {
    title = t('apiState.unauthorizedTitle');
    hint = t('apiState.unauthorizedHint');
  } else if (error instanceof ForbiddenError) {
    title = t('apiState.forbiddenTitle');
    hint = t('apiState.forbiddenHint');
  } else if (error instanceof RateLimitError) {
    title = t('apiState.rateLimitTitle');
    hint =
      error.retryAfterSeconds !== undefined
        ? t('apiState.rateLimitHintTimed', { seconds: error.retryAfterSeconds })
        : t('apiState.rateLimitHint');
  } else if (error instanceof NetworkError || error instanceof TimeoutError) {
    title = t('apiState.offlineTitle');
    hint = t('apiState.offlineHint');
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
            {t('apiState.tryAgain')}
          </button>
        </p>
      ) : null}
    </div>
  );
}

/** Shown above fixture data when the API is unreachable (source === 'fallback'). */
export function OfflineDataNotice({ children }: { children?: ReactNode }) {
  const { t } = useT();
  return (
    <p className="notice notice-info" role="status">
      {children ?? t('apiState.offlineFallback')}
    </p>
  );
}

/** Shown when the API returned live data while a background refresh runs. */
export function RefreshingNotice() {
  const { t } = useT();
  return (
    <p className="small muted" role="status" aria-live="polite">
      {t('apiState.refreshing')}
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
  return <>{empty ?? <DefaultEmptyState />}</>;
}

/** Locale-aware default empty state (QueryState itself takes ReactNode). */
function DefaultEmptyState() {
  const { t } = useT();
  return <EmptyState title={t('apiState.emptyDefault')} />;
}
