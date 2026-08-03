'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';

/** Minimal shape of the non-standard beforeinstallprompt event. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DISMISS_KEY = 'agric.install.dismissed';

/**
 * Minimal, non-aggressive install affordance: the banner only appears when
 * the browser itself fires `beforeinstallprompt` (i.e. the PWA install
 * criteria are already met and the browser considers it appropriate), never
 * on a timer or on first paint. Dismissing it persists on the device so the
 * user is never nagged twice. Browsers without the event (iOS Safari) see
 * nothing — no fake instructions.
 */
export function InstallPrompt() {
  const { t } = useT();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (window.localStorage.getItem(DISMISS_KEY) === '1') return;
    } catch {
      // Storage unavailable — still allow the prompt for this session.
    }
    const onBeforeInstallPrompt = (event: Event) => {
      // Keep the browser's default mini-infobar from showing; we present our
      // own dismissible banner instead.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => setDeferred(null);
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  if (!deferred) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // ignore — the banner simply reappears next session
    }
    setDeferred(null);
  };

  const install = () => {
    const event = deferred;
    setDeferred(null);
    void event.prompt().catch(() => {
      // The browser rejected the prompt — nothing to recover here.
    });
  };

  return (
    <div className="sw-update" role="status" data-testid="install-prompt">
      <span>
        <strong>{t('install.title')}</strong> {t('install.body')}
      </span>
      <button type="button" className="btn btn-primary btn-small" onClick={install}>
        {t('install.action')}
      </button>
      <button type="button" className="btn btn-ghost btn-small" onClick={dismiss}>
        {t('install.dismiss')}
      </button>
    </div>
  );
}
