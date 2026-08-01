'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary body (used by each route's error.tsx).
 * Renders a friendly, on-brand failure state with a retry, and never
 * leaks stack traces.
 */
export function RouteError({
  error,
  reset,
  title = 'This page hit a problem'
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
}) {
  useEffect(() => {
    // Surface to the console for diagnostics; the UI stays friendly.
    console.error('[route-error]', error);
  }, [error]);

  return (
    <div className="container">
      <div className="empty" role="alert" style={{ marginTop: '2rem' }}>
        <p style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{title}</p>
        <p className="small">
          {error.message || 'An unexpected error occurred.'} Your offline data and queued submissions
          are safe on this device.
        </p>
        <p style={{ marginTop: '0.75rem', marginBottom: 0 }}>
          <button type="button" className="btn btn-primary btn-small" onClick={reset}>
            Try again
          </button>{' '}
          <a className="btn btn-ghost btn-small" href="/offline">
            Work offline
          </a>
        </p>
      </div>
    </div>
  );
}
