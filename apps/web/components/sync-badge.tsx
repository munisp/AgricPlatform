'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { getSharedSyncStore, useSyncStatus, WEB_SYNC_ENTITIES } from '@/lib/sync/react';

/**
 * Record-level sync status indicator (Wave SYNCCLIENT). Honest states only:
 * failures and pending work first, "Synced" only when the store can prove a
 * clean pass. "Sync now" is the explicit scheduler entry point — no
 * background timers.
 */
export function SyncBadge() {
  const { t } = useT();
  const store = getSharedSyncStore();
  const status = useSyncStatus(store);
  const [busy, setBusy] = useState(false);

  const parts: string[] = [];
  if (status.syncing || busy) {
    parts.push(t('sync.syncing'));
  } else {
    if (status.lastError) parts.push(t('sync.failed'));
    if (status.pending > 0) parts.push(t('sync.pending', { count: String(status.pending) }));
    if (status.conflictsResolved > 0) {
      parts.push(t('sync.conflictsResolved', { count: String(status.conflictsResolved) }));
    }
    if (!status.lastError && status.pending === 0 && status.lastSyncAt) {
      parts.unshift(t('sync.synced'));
    }
    if (parts.length === 0) {
      parts.push(t('sync.notSyncedYet'));
    }
  }

  const syncNow = async () => {
    setBusy(true);
    try {
      await store.syncNow(WEB_SYNC_ENTITIES);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cluster" role="status" aria-live="polite">
      <span className="small muted" data-testid="sync-badge">
        {parts.join(' · ')}
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-small"
        onClick={() => void syncNow()}
        disabled={busy || status.syncing}
      >
        {t('sync.syncNow')}
      </button>
    </div>
  );
}
