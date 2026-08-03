'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';

/**
 * Registers /sw.js and surfaces a message-gated update flow: when a new
 * service worker is waiting, an "Update available" banner (role="status")
 * offers a refresh. Nothing reloads until the user confirms — the SW
 * skips waiting only after receiving {type:'SKIP_WAITING'}, and the
 * controllerchange → reload follows that click. Farmers are never yanked
 * mid-form by a background update.
 */
export function ServiceWorkerRegister() {
  const { t } = useT();
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;

    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        if (registration.waiting) {
          setWaitingWorker(registration.waiting);
        }
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            // New worker installed while an old one still controls the page.
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              setWaitingWorker(worker);
            }
          });
        });
      })
      .catch(() => {
        // Registration failures must never break the app shell.
      });

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  if (!waitingWorker) return null;

  return (
    <div className="sw-update" role="status">
      <span>{t('sw.updateAvailable')}</span>
      <button
        type="button"
        className="btn btn-primary btn-small"
        onClick={() => waitingWorker.postMessage({ type: 'SKIP_WAITING' })}
      >
        {t('sw.refreshNow')}
      </button>
    </div>
  );
}
