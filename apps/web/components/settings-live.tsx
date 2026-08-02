'use client';

import { useState } from 'react';
import type { KnowledgeResource } from '@agric-platform/shared';
import { useApiQuery } from '@/lib/api/hooks';
import { apiUrl } from '@/lib/api/client';
import { listKnowledgeResources } from '@/lib/api/endpoints';
import { formatBytes, getSessionDataUsageBytes, useReduceData } from '@/lib/data-usage';
import { cacheUrlsForOffline } from '@/lib/offline-pack';
import { usePersistentState } from '@/lib/use-persistent-state';
import { CheckRow } from '@/components/forms';
import { ApiErrorNotice, OfflineDataNotice, QueryState } from '@/components/api-state';
import { StatusBadge } from '@/components/ui';

/* ------------------------------ data usage ------------------------------ */

export function DataUsageSection() {
  const [reduceData, setReduceData] = useReduceData();
  const [bytes, setBytes] = useState<number | null>(null);

  return (
    <div className="card">
      <h3>Data usage this session</h3>
      <p className="small muted">
        Estimated from your browser&apos;s resource timing — everything this tab has downloaded
        since it loaded. It resets when you close the tab.
      </p>
      <div className="cluster">
        <span className="metric-value" data-testid="data-usage-value">
          {bytes === null ? '—' : formatBytes(bytes)}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={() => setBytes(getSessionDataUsageBytes())}
        >
          {bytes === null ? 'Measure now' : 'Refresh estimate'}
        </button>
      </div>
      <div style={{ marginTop: '0.75rem' }}>
        <CheckRow
          id="reduce-data"
          checked={reduceData}
          onChange={setReduceData}
          label="Reduce data usage"
          description="Defers non-essential media: podcast audio is not preloaded and offscreen images lazy-load. API payloads are unchanged in Phase 1."
        />
      </div>
      {reduceData ? (
        <StatusBadge tone="success">reduced data mode on</StatusBadge>
      ) : null}
    </div>
  );
}

/* ----------------------------- offline pack ----------------------------- */

function OfflineResourceRow({
  resource,
  downloaded,
  onDownloaded
}: {
  resource: KnowledgeResource;
  downloaded: boolean;
  onDownloaded: (id: string) => void;
}) {
  const [state, setState] = useState<'idle' | 'downloading' | 'error'>('idle');
  const [error, setError] = useState<unknown>(undefined);

  const download = async () => {
    setState('downloading');
    setError(undefined);
    try {
      await cacheUrlsForOffline([apiUrl(`/knowledge-resources/${resource.id}`)]);
      onDownloaded(resource.id);
      setState('idle');
    } catch (err) {
      setError(err);
      setState('error');
    }
  };

  return (
    <li className="row-item">
      <div className="row-main">
        <div className="row-title">{resource.title}</div>
        <div className="small muted">
          {resource.format} · {resource.tags.join(', ') || 'general'}
        </div>
        {state === 'error' ? <ApiErrorNotice error={error} onRetry={() => void download()} /> : null}
      </div>
      {downloaded ? (
        <StatusBadge tone="success">saved for offline</StatusBadge>
      ) : (
        <button
          type="button"
          className="btn btn-ghost btn-small"
          disabled={state === 'downloading'}
          onClick={() => void download()}
          aria-label={`Download ${resource.title} for offline reading`}
        >
          {state === 'downloading' ? 'Saving…' : 'Download for offline'}
        </button>
      )}
    </li>
  );
}

export function OfflinePackSection() {
  const [downloadedIds, setDownloadedIds] = usePersistentState<string[]>(
    'agric.offline-pack',
    []
  );

  const query = useApiQuery(
    'offline-pack:resources',
    () =>
      listKnowledgeResources({ offlineAvailable: true, pageSize: 60 }).then((res) => res.data),
    { fallbackData: [] }
  );

  return (
    <div className="card">
      <h3>Offline content pack</h3>
      <p className="small muted">
        Save knowledge resources to this device. They are cached by the service worker and stay
        readable with no connection.
      </p>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={query.data}
        onRetry={query.refresh}
        empty={
          <p className="small muted">No offline-ready resources published yet.</p>
        }
      >
        <ul className="row-list">
          {(query.data ?? []).map((resource) => (
            <OfflineResourceRow
              key={resource.id}
              resource={resource}
              downloaded={downloadedIds.includes(resource.id)}
              onDownloaded={(id) => setDownloadedIds((current) => [...current, id])}
            />
          ))}
        </ul>
      </QueryState>
    </div>
  );
}
