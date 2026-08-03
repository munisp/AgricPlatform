'use client';

import { useState } from 'react';
import { useAppState } from '@/lib/app-state';
import { useT } from '@/lib/i18n';
import { AutoBadge } from '@/components/ui';
import { SyncBadge } from '@/components/sync-badge';

const PENDING_STATUSES = new Set(['queued', 'failed']);

export function QueueList() {
  const { queue, clearQueue, syncQueue, retryItem, hydrated } = useAppState();
  const { t } = useT();
  const [syncing, setSyncing] = useState(false);

  if (!hydrated) {
    return <p className="muted small">{t('queue.loading')}</p>;
  }

  if (queue.length === 0) {
    return (
      <div className="empty">
        <p style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{t('queue.emptyTitle')}</p>
        <p className="small">{t('queue.emptyHint')}</p>
      </div>
    );
  }

  const pending = queue.filter((item) => PENDING_STATUSES.has(item.status));

  const sync = async () => {
    setSyncing(true);
    try {
      await syncQueue();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="stack">
      {pending.length > 0 ? (
        <div className="notice" role="status">
          <strong>
            {t(pending.length === 1 ? 'queue.pendingOne' : 'queue.pendingMany', {
              count: pending.length
            })}
          </strong>{' '}
          {t('queue.pendingBody')}
        </div>
      ) : (
        <div className="notice notice-success" role="status">
          <strong>{t('queue.caughtUpTitle')}</strong> {t('queue.caughtUpBody')}
        </div>
      )}
      <ul className="row-list">
        {queue.map((item) => (
          <li className="row-item" key={item.id}>
            <div className="row-main">
              <div className="row-title">{item.label}</div>
              <div className="small muted">
                {item.kind} · {new Date(item.createdAt).toLocaleString('en-NG')}
                {item.attempts > 0
                  ? ` · ${t(item.attempts === 1 ? 'queue.attemptOne' : 'queue.attemptMany', {
                      count: item.attempts
                    })}`
                  : ''}
              </div>
              {item.lastError ? <div className="small muted">{item.lastError}</div> : null}
            </div>
            <AutoBadge
              value={item.status}
              ariaLabel={t('queue.statusAria', { status: item.status.replace(/_/g, ' ') })}
            />
            {item.status === 'failed' && item.path ? (
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => void retryItem(item.id)}
              >
                {t('queue.retry')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="cluster">
        {/* Request-queue flush (queued form submissions) — deliberately
            labelled differently from the record-level sync action in
            SyncBadge below; the two layers have different semantics. */}
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={syncing || pending.length === 0}
          onClick={() => void sync()}
        >
          {syncing ? t('queue.sendingQueued') : t('queue.sendQueued')}
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={clearQueue}>
          {t('queue.clear')}
        </button>
      </div>
      {/* Record-level sync status (notifications/listings cache) — separate
          from the request queue above. */}
      <SyncBadge />
    </div>
  );
}
