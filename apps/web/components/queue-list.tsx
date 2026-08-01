'use client';

import { useAppState } from '@/lib/app-state';

export function QueueList() {
  const { queue, clearQueue, hydrated } = useAppState();

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

  return (
    <div className="stack">
      <div className="notice" role="status">
        <strong>{queue.length} submission{queue.length === 1 ? '' : 's'} queued.</strong> They are stored
        on this device and will be sent with idempotency keys when connectivity returns.
      </div>
      <ul className="row-list">
        {queue.map((item) => (
          <li className="row-item" key={item.id}>
            <div className="row-main">
              <div className="row-title">{item.label}</div>
              <div className="small muted">
                {item.kind} · {new Date(item.createdAt).toLocaleString('en-NG')}
              </div>
            </div>
            <span className="badge badge-warning">queued</span>
          </li>
        ))}
      </ul>
      <div>
        <button type="button" className="btn btn-ghost btn-small" onClick={clearQueue}>
          Clear local queue
        </button>
      </div>
    </div>
  );
}
