'use client';

import { useState } from 'react';
import { NOTIFICATION_CHANNELS } from '@agric-platform/shared';
import type { NotificationChannel } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { usePersistentState } from '@/lib/use-persistent-state';
import { CheckRow, QueuedNotice } from '@/components/forms';

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
  const { enqueue } = useAppState();
  const [prefs, setPrefs] = usePersistentState<Record<NotificationChannel, boolean>>(
    'agric.notification-prefs',
    DEFAULT_PREFS
  );
  const [quietHours, setQuietHours] = usePersistentState<boolean>('agric.quiet-hours', true);
  const [notice, setNotice] = useState(false);

  const save = () => {
    enqueue('notification.preferences.updated', 'Notification preferences updated');
    setNotice(true);
  };

  return (
    <div className="stack">
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
              setNotice(false);
            }}
            label={CHANNEL_INFO[channel].label}
            description={
              channel === 'in_app'
                ? `${CHANNEL_INFO[channel].description} (always on)`
                : CHANNEL_INFO[channel].description
            }
          />
        ))}
        <hr className="divider" />
        <CheckRow
          id="pref-quiet"
          checked={quietHours}
          onChange={(checked) => {
            setQuietHours(checked);
            setNotice(false);
          }}
          label="Quiet hours (8pm – 6am)"
          description="Non-critical SMS, WhatsApp and push messages are held until morning."
        />
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.5rem' }}>
          <button type="button" className="btn btn-primary" onClick={save}>
            Save preferences
          </button>
        </div>
      </div>
      {notice ? <QueuedNotice label="Your notification preferences" /> : null}
    </div>
  );
}
