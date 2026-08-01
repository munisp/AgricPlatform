'use client';

import { useEffect, useState } from 'react';
import { NOTIFICATION_CHANNELS } from '@agric-platform/shared';
import type { NotificationChannel } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { useSession } from '@/lib/session';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  fetchNotificationPreferences,
  setNotificationPreferences
} from '@/lib/api/endpoints';
import { CheckRow, QueuedNotice } from '@/components/forms';
import { OfflineDataNotice } from '@/components/api-state';

const CHANNEL_INFO: Record<NotificationChannel, { label: string; description: string }> = {
  in_app: { label: 'In-app', description: 'Always available, including offline.' },
  sms: { label: 'SMS', description: 'Delivered via Termii; standard carrier rates may apply.' },
  whatsapp: { label: 'WhatsApp', description: 'Chapter reminders and digests via 360dialog.' },
  email: { label: 'Email', description: 'Weekly summaries and certificate notices.' },
  push: { label: 'Push', description: 'Web push via OneSignal on supported devices.' }
};

const DEFAULT_PREFS: Record<NotificationChannel, boolean> = {
  in_app: true,
  sms: true,
  whatsapp: false,
  email: false,
  push: false
};

export function NotificationPreferences() {
  const { userId } = useAppState();
  const { hydrated } = useSession();
  const [prefs, setPrefs] = useState<Record<NotificationChannel, boolean>>(DEFAULT_PREFS);
  const [notice, setNotice] = useState<'saved' | 'queued' | null>(null);

  const query = useApiQuery(
    hydrated ? `notifications:preferences:${userId}` : null,
    () => fetchNotificationPreferences(userId).then((res) => res.data),
    { enabled: hydrated }
  );

  // Adopt server-side preferences when they arrive.
  useEffect(() => {
    if (!query.data) return;
    setPrefs((current) => {
      const next = { ...current };
      for (const pref of query.data!) {
        next[pref.channel] = pref.enabled;
      }
      return next;
    });
  }, [query.data]);

  const saveMutation = useApiMutation<
    Array<{ channel: NotificationChannel; enabled: boolean }>,
    unknown
  >({
    mutationFn: (preferences) => setNotificationPreferences(userId, preferences),
    queue: {
      kind: 'notification.preferences.updated',
      label: () => 'Notification preferences updated',
      method: 'PUT',
      path: () => `/notifications/preferences/${userId}`,
      payload: (preferences) => ({ preferences })
    },
    onSuccess: () => setNotice('saved'),
    onQueued: () => setNotice('queued')
  });

  const save = () => {
    const preferences = NOTIFICATION_CHANNELS.map((channel) => ({
      channel,
      enabled: prefs[channel]
    }));
    void saveMutation.mutate(preferences);
  };

  return (
    <div className="stack">
      {query.error && query.source !== 'api' ? (
        <OfflineDataNotice>
          Preferences could not be loaded from the API — changes are saved to the sync queue.
        </OfflineDataNotice>
      ) : null}
      <div className="card">
        <h3>Channels</h3>
        {NOTIFICATION_CHANNELS.map((channel) => (
          <CheckRow
            key={channel}
            id={`pref-${channel}`}
            checked={prefs[channel]}
            disabled={channel === 'in_app'}
            onChange={(checked) => {
              setPrefs((current) => ({ ...current, [channel]: checked }));
              setNotice(null);
            }}
            label={CHANNEL_INFO[channel].label}
            description={
              channel === 'in_app'
                ? `${CHANNEL_INFO[channel].description} (always on)`
                : CHANNEL_INFO[channel].description
            }
          />
        ))}
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.5rem' }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saveMutation.status === 'pending'}
            onClick={save}
          >
            {saveMutation.status === 'pending' ? 'Saving…' : 'Save preferences'}
          </button>
        </div>
      </div>
      {notice === 'saved' ? (
        <div className="notice notice-success" role="status">
          <strong>Preferences saved.</strong> They apply to all channels immediately.
        </div>
      ) : null}
      {notice === 'queued' ? <QueuedNotice label="Your notification preferences" /> : null}
    </div>
  );
}
