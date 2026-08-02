'use client';

import { useState } from 'react';
import { useAppState } from '@/lib/app-state';
import { AutoBadge } from '@/components/ui';

const PENDING_STATUSES = new Set(['queued', 'failed']);

export function QueueList() {
  const { queue, clearQueue, syncQueue, retryItem, hydrated } = useAppState();
  const [syncing, setSyncing] = useState(false);

  if (!hydrated) {
    return <p className="muted small">Loading offline queue…</p>;
  }

  if (queue.length === 0) {
    return (
      <div className="empty">
        <p style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Nothing waiting to sync</p>
        <p className="small">
          Forms you submit while offline (applications, listings, attendance, privacy requests) will
          appear here and sync automatically once the API is connected.
        </p>
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
            {pending.length} submission{pending.length === 1 ? '' : 's'} waiting to sync.
          </strong>{' '}
          They are stored on this device and replay with their original idempotency keys when
          connectivity returns.
        </div>
      ) : (
        <div className="notice notice-success" role="status">
          <strong>All caught up.</strong> Every submission on this device has been synced.
        </div>
      )}
      <ul className="row-list">
        {queue.map((item) => (
          <li className="row-item" key={item.id}>
            <div className="row-main">
              <div className="row-title">{item.label}</div>
              <div className="small muted">
                {item.kind} · {new Date(item.createdAt).toLocaleString('en-NG')}
                {item.attempts > 0 ? ` · ${item.attempts} attempt${item.attempts === 1 ? '' : 's'}` : ''}
              </div>
              {item.lastError ? <div className="small muted">{item.lastError}</div> : null}
            </div>
            <AutoBadge value={item.status} ariaLabel={`Sync status: ${item.status.replace(/_/g, ' ')}`} />
            {item.status === 'failed' && item.path ? (
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => void retryItem(item.id)}
              >
                Retry
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="cluster">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={syncing || pending.length === 0}
          onClick={() => void sync()}
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={clearQueue}>
          Clear local queue
        </button>
      </div>
    </div>
  );
}
