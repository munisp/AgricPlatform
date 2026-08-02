'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationMessage } from '@agric-platform/shared';
import { getAuthIdentity } from '@/lib/api/client';
import { useApiQuery } from '@/lib/api/hooks';
import {
  evaluateFeatureFlag,
  listNotifications,
  notificationStreamUrl,
  type NotificationStreamPayload
} from '@/lib/api/endpoints';
import { useSession } from '@/lib/session';
import { useT } from '@/lib/i18n';

/**
 * Live notification bell (Wave P). When the `notifications.sse` feature
 * flag is on for the caller, an EventSource stream pushes unread-count
 * updates (no client polling); when the flag is off or the stream errors,
 * the bell degrades gracefully to the existing polling query.
 */
export function NotificationBell() {
  const { userId, hydrated } = useSession();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState<NotificationStreamPayload | null>(null);
  const [sseActive, setSseActive] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  // Polling fallback (also the initial snapshot before the first push).
  const query = useApiQuery(
    `notifications:bell:${userId}`,
    () => listNotifications(userId).then((res) => res.data),
    { enabled: hydrated && Boolean(userId), staleTimeMs: 30_000 }
  );

  useEffect(() => {
    if (!hydrated || !userId) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const flag = await evaluateFeatureFlag('notifications.sse');
        if (cancelled || !flag.data.enabled) {
          return;
        }
        const url = notificationStreamUrl(getAuthIdentity());
        if (!url || typeof EventSource === 'undefined') {
          return;
        }
        const source = new EventSource(url);
        sourceRef.current = source;
        source.onopen = () => setSseActive(true);
        source.onmessage = (message) => {
          try {
            setLive(JSON.parse(message.data as string) as NotificationStreamPayload);
          } catch {
            // Ignore malformed frames; the next push re-syncs.
          }
        };
        source.onerror = () => {
          // Graceful fallback: close the stream and keep polling.
          setSseActive(false);
          source.close();
          sourceRef.current = null;
        };
      } catch {
        // Flag evaluation failed (offline/forbidden): stay on polling.
      }
    })();
    return () => {
      cancelled = true;
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [hydrated, userId]);

  const notifications: NotificationMessage[] =
    live?.notifications ?? query.data?.filter((message) => message.status !== 'read') ?? [];
  const unreadCount = live?.unreadCount ?? notifications.length;

  const toggle = useCallback(() => setOpen((value) => !value), []);

  return (
    <div className="notification-bell">
      <button
        type="button"
        className="bell-button"
        aria-label={t('notifications.bellLabel')}
        aria-expanded={open}
        onClick={toggle}
      >
        <span aria-hidden="true">🔔</span>
        <span className="bell-text">{t('notifications.bell')}</span>
        {unreadCount > 0 ? (
          <span className="bell-badge" data-testid="bell-badge">
            {unreadCount}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="bell-panel" role="region" aria-label={t('notifications.panelLabel')}>
          {notifications.length === 0 ? (
            <p className="small muted">{t('notifications.empty')}</p>
          ) : (
            <ul>
              {notifications.slice(0, 8).map((message) => (
                <li key={message.id}>
                  <strong>{message.title}</strong>
                  <span className="small muted"> {message.body}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="small muted" data-testid="bell-mode">
            {sseActive ? t('notifications.live') : t('notifications.polling')}
          </p>
        </div>
      ) : null}
    </div>
  );
}
