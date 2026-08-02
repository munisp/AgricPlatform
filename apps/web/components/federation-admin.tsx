'use client';

import { useEffect, useState } from 'react';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  confirmImportBatch,
  fetchImportBatch,
  listExternalAccountLinks,
  listMyFarmRecords,
  pullBeneficiaryImport,
  revokeExternalAccountLink,
  syncFarmRecords
} from '@/lib/api/endpoints';
import type {
  ExternalAccountLink,
  ImportBatchDetail,
  ImportConfirmResult,
  ImportRecord
} from '@/lib/api/endpoints';
import { ApiErrorNotice, QueryState } from '@/components/api-state';
import { Field, TextInput } from '@/components/forms';
import { AutoBadge, Card, EmptyState, StatusBadge } from '@/components/ui';

/**
 * Federation admin surfaces (Wave P6c): external account links with consent
 * dates and revoke, farm-record sync + recent records, and the beneficiary
 * import confirm-before-merge flow.
 *
 * API adaptations (no list-all endpoints exist):
 *  - GET /integrations/federation/links is ownership-scoped, so the table
 *    shows the signed-in admin's own links.
 *  - There is no "list all import batches" endpoint, so batch ids created by
 *    the pull trigger (plus manually entered ids) are remembered on this
 *    device and re-fetched individually.
 *  - There is no per-record REJECT endpoint: rows failing validation are
 *    REJECTED automatically at staging; the reason is shown from the payload.
 */

const RECENT_BATCHES_KEY = 'agric.federation.recentBatchIds';

function loadRecentBatchIds(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_BATCHES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function rememberBatchIds(ids: string[]): void {
  try {
    const existing = loadRecentBatchIds();
    const next = [...new Set([...ids, ...existing])].slice(0, 10);
    window.localStorage.setItem(RECENT_BATCHES_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private mode) — recents simply don't persist.
  }
}

function formatDate(value: string | undefined): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleDateString('en-NG', { dateStyle: 'medium' });
}

function payloadSummary(record: ImportRecord): string {
  const payload = record.payload ?? {};
  const name = typeof payload.fullName === 'string' ? payload.fullName : undefined;
  const reason = typeof payload.rejectionReason === 'string' ? payload.rejectionReason : undefined;
  const parts = [
    name,
    record.phoneHash ? `phone ${record.phoneHash.slice(0, 8)}…` : undefined,
    record.ninHash ? `nin ${record.ninHash.slice(0, 8)}…` : undefined,
    reason ? `reason: ${reason}` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/* ------------------------ external account links ----------------------- */

function LinkRow({
  link,
  onRevoked
}: {
  link: ExternalAccountLink;
  onRevoked: (updated: ExternalAccountLink) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const revoke = useApiMutation<void, ExternalAccountLink>({
    mutationFn: () => revokeExternalAccountLink(link.id).then((res) => res.data),
    onSuccess: (updated) => {
      setConfirming(false);
      onRevoked(updated);
    }
  });

  const revoked = Boolean(link.revokedAt);

  return (
    <tr>
      <td>{link.system}</td>
      <td>{link.externalId}</td>
      <td>{formatDate(link.consentAt)}</td>
      <td>
        {revoked ? (
          <StatusBadge tone="neutral">revoked</StatusBadge>
        ) : (
          <StatusBadge tone="success">active</StatusBadge>
        )}
      </td>
      <td>
        {revoked ? (
          <span className="small muted">Revoked {formatDate(link.revokedAt)}</span>
        ) : confirming ? (
          <span className="cluster">
            <span className="small">Revoke this link?</span>
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={revoke.status === 'pending'}
              onClick={() => void revoke.mutate()}
            >
              {revoke.status === 'pending' ? 'Revoking…' : 'Confirm revoke'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => setConfirming(true)}
          >
            Revoke
          </button>
        )}
        {revoke.status === 'error' ? <ApiErrorNotice error={revoke.error} /> : null}
      </td>
    </tr>
  );
}

export function ExternalLinksTable() {
  const query = useApiQuery(
    'federation:links',
    () => listExternalAccountLinks().then((res) => res.data)
  );
  const [updated, setUpdated] = useState<Record<string, ExternalAccountLink>>({});

  const links = (query.data ?? []).map((link) => updated[link.id] ?? link);

  return (
    <Card title="External account links">
      <p className="small muted">
        farmOS / LiteFarm accounts linked with explicit member consent. Revoking is a soft delete —
        the consent record is kept.
      </p>
      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        data={links}
        onRetry={query.refresh}
        empty={<EmptyState title="No linked accounts" hint="Members link accounts from their settings." />}
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">System</th>
                <th scope="col">External ID</th>
                <th scope="col">Consent date</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <LinkRow
                  key={link.id}
                  link={link}
                  onRevoked={(next) => setUpdated((prev) => ({ ...prev, [next.id]: next }))}
                />
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
    </Card>
  );
}

/* ----------------------------- farm records ---------------------------- */

export function FarmRecordsPanel() {
  const query = useApiQuery(
    'federation:farm-records',
    () => listMyFarmRecords().then((res) => res.data)
  );
  const sync = useApiMutation<void, { syncedLinks: number; inserted: number }>({
    mutationFn: () => syncFarmRecords().then((res) => res.data),
    onSuccess: () => query.refresh()
  });

  const records = (query.data ?? []).slice(0, 10);

  return (
    <Card title="Farm records">
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <p className="small muted" style={{ margin: 0 }}>
          Normalised crop plans, harvests and field maps pulled from linked systems.
        </p>
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={sync.status === 'pending'}
          onClick={() => void sync.mutate()}
        >
          {sync.status === 'pending' ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
      {sync.status === 'success' && sync.data ? (
        <div className="notice notice-success" role="status">
          <strong>Sync complete.</strong> {sync.data.syncedLinks} link(s) checked,{' '}
          {sync.data.inserted} new record(s).
        </div>
      ) : null}
      {sync.status === 'error' ? <ApiErrorNotice error={sync.error} /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        data={records}
        onRetry={query.refresh}
        empty={<EmptyState title="No farm records yet" hint="Link an account and run a sync." />}
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Source</th>
                <th scope="col">External ID</th>
                <th scope="col">Observed</th>
                <th scope="col">Synced</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>
                    <AutoBadge value={record.recordType} />
                  </td>
                  <td>{record.source}</td>
                  <td>{record.externalId}</td>
                  <td>{formatDate(record.observedAt)}</td>
                  <td>{formatDate(record.syncedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
    </Card>
  );
}

/* ----------------------------- beneficiary import ---------------------- */

function ConfirmMergeDialog({
  result,
  onClose
}: {
  result: ImportConfirmResult;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay">
      <div
        className="card modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-summary-title"
        tabIndex={-1}
        ref={(node) => node?.focus()}
      >
        <h3 id="merge-summary-title">Import merged</h3>
        <p className="small muted">
          Batch {result.batch.id} from {result.batch.donorSource} is confirmed.
        </p>
        <ul className="row-list">
          <li className="row-item">
            <div className="row-main">
              <div className="row-title">Records merged</div>
            </div>
            <StatusBadge tone="success">{result.merged}</StatusBadge>
          </li>
          <li className="row-item">
            <div className="row-main">
              <div className="row-title">Records rejected</div>
            </div>
            <StatusBadge tone={result.rejected > 0 ? 'warning' : 'neutral'}>
              {result.rejected}
            </StatusBadge>
          </li>
        </ul>
        <div className="cluster" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function BatchDetail({
  batchId,
  onConfirmed
}: {
  batchId: string;
  onConfirmed: (result: ImportConfirmResult) => void;
}) {
  const query = useApiQuery(
    `federation:import-batch:${batchId}`,
    () => fetchImportBatch(batchId).then((res) => res.data)
  );
  const [detail, setDetail] = useState<ImportBatchDetail | undefined>();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (query.data) setDetail(query.data);
  }, [query.data]);

  const confirm = useApiMutation<void, ImportConfirmResult>({
    mutationFn: () => confirmImportBatch(batchId).then((res) => res.data),
    onSuccess: (result) => {
      setConfirming(false);
      setDetail((prev) =>
        prev
          ? {
              batch: result.batch,
              records: prev.records.map((record) =>
                record.status === 'STAGED' ? { ...record, status: 'MERGED' as const } : record
              )
            }
          : prev
      );
      onConfirmed(result);
    }
  });

  const current = detail ?? query.data;
  const batch = current?.batch;
  const records = current?.records ?? [];
  const stagedCount = records.filter((record) => record.status === 'STAGED').length;

  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.error}
      data={batch ? [batch] : undefined}
      onRetry={query.refresh}
      empty={<EmptyState title="Batch not found" hint="Check the batch id and try again." />}
    >
      {batch ? (
        <div className="stack">
          <div className="cluster" style={{ justifyContent: 'space-between' }}>
            <div>
              <div className="row-title">Batch {batch.id}</div>
              <div className="small muted">
                {batch.sourceSystem} · donor: {batch.donorSource} · created{' '}
                {formatDate(batch.createdAt)}
              </div>
            </div>
            <span className="cluster">
              <AutoBadge value={batch.status.toLowerCase()} />
              {batch.status === 'STAGED' ? (
                confirming ? (
                  <>
                    <span className="small">
                      Merge {stagedCount} staged record{stagedCount === 1 ? '' : 's'}?
                    </span>
                    <button
                      type="button"
                      className="btn btn-primary btn-small"
                      disabled={confirm.status === 'pending'}
                      onClick={() => void confirm.mutate()}
                    >
                      {confirm.status === 'pending' ? 'Merging…' : 'Confirm merge'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      onClick={() => setConfirming(false)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    onClick={() => setConfirming(true)}
                  >
                    Review &amp; merge
                  </button>
                )
              ) : (
                <span className="small muted">Confirmed {formatDate(batch.confirmedAt)}</span>
              )}
            </span>
          </div>
          {confirm.status === 'error' ? <ApiErrorNotice error={confirm.error} /> : null}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Record</th>
                  <th scope="col">Donor source</th>
                  <th scope="col">Consent date</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <td>{payloadSummary(record)}</td>
                    <td>{record.donorSource}</td>
                    <td>{formatDate(record.consentDate)}</td>
                    <td>
                      <AutoBadge value={record.status.toLowerCase()} />
                      {record.matchedUserId ? (
                        <span className="small muted"> deduped to member</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </QueryState>
  );
}

export function ImportBatchesPanel() {
  const [batchIdInput, setBatchIdInput] = useState('');
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [mergeResult, setMergeResult] = useState<ImportConfirmResult | null>(null);

  useEffect(() => {
    setRecentIds(loadRecentBatchIds());
  }, []);

  const pull = useApiMutation<{ donorSource: string }, { batchIds: string[] }>({
    mutationFn: ({ donorSource }) => pullBeneficiaryImport({ donorSource }).then((res) => res.data),
    onSuccess: (result) => {
      if (result.batchIds.length > 0) {
        rememberBatchIds(result.batchIds);
        setRecentIds(loadRecentBatchIds());
        setSelectedBatchId(result.batchIds[0]);
      }
    }
  });

  const [donorSource, setDonorSource] = useState('');

  return (
    <Card title="Beneficiary imports">
      <p className="small muted">
        Staged ODK/Kobo batches merge only after an explicit confirm. Rows that fail consent or
        identity validation are rejected automatically at staging — the reason is listed per row.
      </p>

      <div className="form-grid cols-2">
        <Field id="import-donor" label="Donor source" hint="Programme label for the pull, e.g. giz-southwest.">
          <TextInput
            id="import-donor"
            value={donorSource}
            onChange={(e) => setDonorSource(e.target.value)}
            placeholder="giz-southwest"
          />
        </Field>
        <Field id="import-batch-id" label="Batch ID" hint="Open a staged batch by id.">
          <TextInput
            id="import-batch-id"
            value={batchIdInput}
            onChange={(e) => setBatchIdInput(e.target.value)}
            placeholder="batch-…"
          />
        </Field>
      </div>
      <div className="cluster" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!donorSource.trim() || pull.status === 'pending'}
          onClick={() => void pull.mutate({ donorSource: donorSource.trim() })}
        >
          {pull.status === 'pending' ? 'Pulling…' : 'Pull submissions'}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!batchIdInput.trim()}
          onClick={() => setSelectedBatchId(batchIdInput.trim())}
        >
          Open batch
        </button>
      </div>
      {pull.status === 'success' && pull.data ? (
        <div className="notice notice-success" role="status">
          <strong>Pull complete.</strong>{' '}
          {pull.data.batchIds.length > 0
            ? `${pull.data.batchIds.length} batch(es) staged: ${pull.data.batchIds.join(', ')}`
            : 'No new submissions at the configured sources.'}
        </div>
      ) : null}
      {pull.status === 'error' ? <ApiErrorNotice error={pull.error} /> : null}

      {recentIds.length > 0 ? (
        <div className="cluster" aria-label="Recent batches on this device">
          <span className="small muted">Recent:</span>
          {recentIds.map((id) => (
            <button
              key={id}
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => setSelectedBatchId(id)}
            >
              {id}
            </button>
          ))}
        </div>
      ) : null}

      {selectedBatchId ? (
        <BatchDetail
          key={selectedBatchId}
          batchId={selectedBatchId}
          onConfirmed={setMergeResult}
        />
      ) : (
        <EmptyState
          title="No batch selected"
          hint="Pull submissions or open a batch by id to review staged records."
        />
      )}

      {mergeResult ? (
        <ConfirmMergeDialog result={mergeResult} onClose={() => setMergeResult(null)} />
      ) : null}
    </Card>
  );
}
