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
import { getSharedSyncStore, useSyncStatus } from '@/lib/sync/react';
import type { SyncStore } from '@/lib/sync/store';

/** Unread notifications held in the record-level sync cache (payloads are
 * server notification rows; malformed entries are ignored, never shown). */
function readCachedNotifications(store: SyncStore): NotificationMessage[] {
  return store
    .getRecords('notification')
    .map((record) => record.payload)
    .filter(
      (payload): payload is NotificationMessage =>
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as NotificationMessage).id === 'string' &&
        (payload as NotificationMessage).status !== 'read'
    );
}

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

  // Record-level sync cache (Wave SYNCCLIENT): opening the panel is an
  // explicit sync point, and when the API is unreachable the last synced
  // cache serves the dropdown with an honest "offline" mode line.
  const syncStore = getSharedSyncStore();
  useSyncStatus(syncStore); // re-render when the cache changes
  const syncCached = readCachedNotifications(syncStore);
  const usingSyncCache = !live && Boolean(query.error) && syncCached.length > 0;

  const notifications: NotificationMessage[] =
    live?.notifications ??
    (usingSyncCache ? syncCached : (query.data?.filter((message) => message.status !== 'read') ?? []));
  const unreadCount = live?.unreadCount ?? notifications.length;

  const toggle = useCallback(() => {
    setOpen((value) => {
      if (!value) {
        // Explicit sync point: refresh the notification cache for offline
        // reads. Fire-and-forget — failures only affect the cache copy.
        void syncStore.syncNow(['notification']);
      }
      return !value;
    });
  }, [syncStore]);

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
            {sseActive
              ? t('notifications.live')
              : usingSyncCache
                ? t('notifications.offlineCache')
                : t('notifications.polling')}
          </p>
        </div>
      ) : null}
    </div>
  );
}
