'use client';

import { useState } from 'react';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import { fetchCreditProfile, listDocuments, uploadDocument } from '@/lib/api/endpoints';
import type { VaultDocument } from '@agric-platform/shared';
import { demoCreditProfile, demoDocuments } from '@/lib/content';
import { Field, Select, TextInput } from '@/components/forms';
import { AutoBadge, Card, ProgressBar } from '@/components/ui';
import { ApiErrorNotice, OfflineDataNotice, QueryState } from '@/components/api-state';

// Offline fallbacks only — live data from GET /api/v1/finance/credit-profile/:userId
// and GET /api/v1/finance/documents?userId=…
const FALLBACK_CREDIT = demoCreditProfile;
const FALLBACK_DOCS = demoDocuments;

const DOC_KINDS: VaultDocument['kind'][] = [
  'national_id',
  'land_title',
  'farm_photo',
  'certificate',
  'business_plan',
  'utility_bill'
];

export function CreditProfileSection() {
  const { userId, hydrated } = useAppState();
  const query = useApiQuery(
    hydrated ? `finance:credit:${userId}` : null,
    () => fetchCreditProfile(userId).then((res) => res.data),
    { fallbackData: FALLBACK_CREDIT, enabled: hydrated }
  );
  const profile = query.data;

  const signals = profile
    ? [
        { label: 'Training signals', value: profile.trainingSignals, max: 30 },
        { label: 'Transaction signals', value: profile.transactionSignals, max: 30 },
        { label: 'Production signals', value: profile.productionSignals, max: 40 }
      ]
    : [];

  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={profile}
        onRetry={query.refresh}
      >
        {profile ? (
          <div className="grid grid-2">
            <Card title={`Score: ${profile.score} / 100`}>
              <ProgressBar value={profile.score} label="Credit readiness" />
              <div className="stack" style={{ marginTop: '1rem' }}>
                {signals.map((signal) => (
                  <ProgressBar
                    key={signal.label}
                    value={(signal.value / signal.max) * 100}
                    label={`${signal.label} (${signal.value}/${signal.max})`}
                  />
                ))}
              </div>
            </Card>
            <Card title="Next best actions">
              <ul className="row-list">
                {profile.improvementActions.map((action) => (
                  <li className="row-item" key={action}>
                    <div className="row-main small">{action}</div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        ) : null}
      </QueryState>
    </>
  );
}

export function DocumentVault() {
  const { userId, hydrated } = useAppState();
  const [kind, setKind] = useState<VaultDocument['kind']>('national_id');
  const [fileName, setFileName] = useState('');

  const query = useApiQuery(
    hydrated ? `finance:documents:${userId}` : null,
    () => listDocuments({ userId }).then((res) => res.data),
    { fallbackData: FALLBACK_DOCS, enabled: hydrated }
  );
  const documents = query.data ?? [];
  const verifiedDocs = documents.filter((doc) => doc.status === 'verified').length;

  const upload = useApiMutation<void, unknown>({
    mutationFn: () =>
      uploadDocument({ userId, kind, fileName: fileName.trim() }).then((res) => res.data),
    queue: {
      kind: 'finance.document.uploaded',
      label: () => `Vault document: ${fileName.trim()}`,
      method: 'POST',
      path: () => '/finance/documents',
      payload: () => ({ userId, kind, fileName: fileName.trim() })
    },
    onSuccess: () => {
      setFileName('');
      query.refresh();
    },
    onQueued: () => setFileName('')
  });

  return (
    <>
      {query.source === 'fallback' ? <OfflineDataNotice /> : null}
      <p className="small muted">
        {documents.length} document{documents.length === 1 ? '' : 's'} · {verifiedDocs} verified · stored
        encrypted; filenames only in this reference build.
      </p>
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' ? undefined : query.error}
        data={documents}
        onRetry={query.refresh}
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Kind</th>
                <th>Uploaded</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td>{doc.fileName}</td>
                  <td>{doc.kind.replace(/_/g, ' ')}</td>
                  <td>{new Date(doc.uploadedAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</td>
                  <td>
                    <AutoBadge value={doc.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h3>Register a document</h3>
        <div className="form-grid cols-2">
          <Field id="doc-kind" label="Document kind">
            <Select
              id="doc-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as VaultDocument['kind'])}
            >
              {DOC_KINDS.map((option) => (
                <option key={option} value={option}>
                  {option.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="doc-name" label="File name">
            <TextInput
              id="doc-name"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              placeholder="e.g. land-lease-scan.pdf"
            />
          </Field>
        </div>
        <div className="cluster" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          {upload.status === 'success' ? <AutoBadge value="uploaded" /> : null}
          {upload.status === 'queued' ? <AutoBadge value="queued" /> : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={fileName.trim().length < 3 || upload.status === 'pending'}
            onClick={() => void upload.mutate()}
          >
            {upload.status === 'pending' ? 'Uploading…' : 'Add to vault'}
          </button>
        </div>
        {upload.status === 'error' ? <ApiErrorNotice error={upload.error} /> : null}
      </div>
    </>
  );
}
