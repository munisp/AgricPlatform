'use client';

import { useEffect, useState } from 'react';
import { toString as qrToString } from 'qrcode';
import { useApiQuery } from '@/lib/api/hooks';
import { fetchEventAttendanceCode } from '@/lib/api/endpoints';
import { ForbiddenError } from '@/lib/api/errors';
import { ApiErrorNotice } from '@/components/api-state';
import { StatusBadge } from '@/components/ui';

/**
 * Rotating QR attendance code for chapter leads/admins. The API signs the
 * code (15-minute rotating window, one rotation of grace); the QR payload is
 * the full signed code string, refreshed automatically before expiry.
 */
export function AttendanceQr({ eventId }: { eventId: string }) {
  const [open, setOpen] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);

  const query = useApiQuery(
    open ? `attendance-code:${eventId}` : null,
    () => fetchEventAttendanceCode(eventId).then((res) => res.data),
    { enabled: open, staleTimeMs: 60_000 }
  );

  const code = query.data?.code;
  const expiresAt = query.data?.expiresAt;

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    void qrToString(code, { type: 'svg', margin: 1, width: 220 })
      .then((markup) => {
        if (!cancelled) setSvg(markup);
      })
      .catch(() => {
        if (!cancelled) setSvg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  // Refresh the code 30s before the grace window ends.
  useEffect(() => {
    if (!expiresAt) return;
    const refreshAt = new Date(expiresAt).getTime() - 30_000 - 15 * 60_000;
    const delay = Math.max(refreshAt - Date.now(), 60_000);
    const timer = setTimeout(() => query.refresh(), delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-ghost btn-small"
        onClick={() => setOpen(true)}
        aria-expanded={false}
      >
        Attendance QR
      </button>
    );
  }

  return (
    <div className="stack" style={{ marginTop: '0.5rem' }}>
      {query.error instanceof ForbiddenError ? (
        <p className="notice notice-info" role="status">
          Only chapter leads and admins can show the attendance code.
        </p>
      ) : query.error ? (
        <ApiErrorNotice error={query.error} onRetry={query.refresh} />
      ) : svg ? (
        <figure style={{ margin: 0 }}>
          <span
            role="img"
            aria-label="QR code for event attendance check-in"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          <figcaption className="small muted">
            Members scan this code to check in. It rotates every 15 minutes.
            {expiresAt
              ? ` Valid until ${new Date(expiresAt).toLocaleTimeString('en-NG', { timeStyle: 'short' })}.`
              : ''}
          </figcaption>
        </figure>
      ) : (
        <p className="small muted">Preparing QR code…</p>
      )}
      <div className="cluster">
        <StatusBadge tone="info">rotating code</StatusBadge>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={() => {
            setOpen(false);
            setSvg(null);
          }}
          aria-expanded={true}
        >
          Hide QR
        </button>
      </div>
    </div>
  );
}
