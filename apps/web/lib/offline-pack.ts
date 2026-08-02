'use client';

/**
 * Offline content pack: asks the service worker to cache URLs into the
 * offline-pack cache via the message-gated pattern (consistent with the
 * SKIP_WAITING update flow). Resolves on the SW ack; rejects with a real
 * error otherwise — callers must surface failures with a retry.
 */
export async function cacheUrlsForOffline(urls: string[]): Promise<void> {
  if (
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !navigator.serviceWorker.controller
  ) {
    throw new Error(
      'The offline service worker is not active yet. Open the app online once, then try again.'
    );
  }
  const controller = navigator.serviceWorker.controller;

  return new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      reject(new Error('The service worker did not respond in time.'));
    }, 15_000);

    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      const data = event.data as { ok?: boolean; error?: string };
      if (data?.ok) {
        resolve();
      } else {
        reject(new Error(data?.error ?? 'The download failed.'));
      }
    };

    controller.postMessage({ type: 'CACHE_URLS', urls }, [channel.port2]);
  });
}
