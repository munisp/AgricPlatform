'use client';

import { useEffect, useState } from 'react';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  exportPrivacyData,
  listConsents,
  recordConsent,
  requestAccountDeletion
} from '@/lib/api/endpoints';
import { CONSENT_PURPOSES } from '@/lib/content';
import { CheckRow, QueuedNotice } from '@/components/forms';
import { ApiErrorNotice, OfflineDataNotice } from '@/components/api-state';

type ConsentMap = Record<string, boolean>;

const DEFAULT_CONSENTS: ConsentMap = CONSENT_PURPOSES.reduce<ConsentMap>((acc, purpose) => {
  acc[purpose.id] = purpose.locked;
  return acc;
}, {});

export function PrivacyCenter() {
  const { userId, hydrated } = useAppState();
  const [consents, setConsents] = useState<ConsentMap>(DEFAULT_CONSENTS);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // GET /privacy/consents/:userId — server records win over defaults.
  const consentsQuery = useApiQuery(
    hydrated ? `privacy:consents:${userId}` : null,
    () => listConsents(userId).then((res) => res.data),
    { enabled: hydrated }
  );

  useEffect(() => {
    if (!consentsQuery.data) return;
    setConsents((current) => {
      const next = { ...current };
      // Latest record per purpose wins.
      for (const record of consentsQuery.data!) {
        next[record.purpose] = record.granted && !record.revokedAt;
      }
      return next;
    });
  }, [consentsQuery.data]);

  const consentMutation = useApiMutation<
    { purpose: string; granted: boolean; label: string },
    unknown
  >({
    mutationFn: ({ purpose, granted }) =>
      recordConsent({ userId, purpose, granted, source: 'privacy-center' }).then((res) => res.data),
    queue: {
      kind: 'privacy.consent.recorded',
      label: ({ label, granted }) => `Consent ${granted ? 'granted' : 'revoked'}: ${label}`,
      method: 'POST',
      path: () => '/privacy/consents',
      payload: ({ purpose, granted }) => ({
        userId,
        purpose,
        granted,
        source: 'privacy-center'
      })
    },
    onQueued: () => setMessage('consent')
  });

  const exportMutation = useApiMutation<void, unknown>({
    mutationFn: () => exportPrivacyData(userId).then((res) => res.data),
    onSuccess: (data) => {
      // Offer the export as an immediate download.
      try {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `agricplatform-export-${userId}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch {
        // Download unsupported — the notice still confirms the export succeeded.
      }
    }
  });

  const deletionMutation = useApiMutation<void, unknown>({
    mutationFn: () => requestAccountDeletion(userId).then((res) => res.data),
    queue: {
      kind: 'privacy.deletion.requested',
      label: () => 'NDPR account deletion request',
      method: 'POST',
      path: () => `/privacy/delete/${userId}`
    },
    onSuccess: () => setMessage('deletion'),
    onQueued: () => setMessage('deletion')
  });

  return (
    <div className="stack-lg">
      {consentsQuery.error ? (
        <OfflineDataNotice>
          Consent records could not be loaded — changes are queued and sync when you reconnect.
        </OfflineDataNotice>
      ) : null}
      <div className="card">
        <h3>Consent management</h3>
        <p className="small muted">
          Each consent is recorded with timestamp, purpose and source, and can be revoked at any time
          under NDPR/NDPA.
        </p>
        {CONSENT_PURPOSES.map((purpose) => (
          <CheckRow
            key={purpose.id}
            id={`consent-${purpose.id}`}
            checked={consents[purpose.id] ?? false}
            disabled={purpose.locked}
            onChange={(checked) => {
              setConsents((current) => ({ ...current, [purpose.id]: checked }));
              void consentMutation.mutate({
                purpose: purpose.id,
                granted: checked,
                label: purpose.label
              });
            }}
            label={purpose.locked ? `${purpose.label} (required)` : purpose.label}
            description={purpose.description}
          />
        ))}
        {consentMutation.status === 'error' ? (
          <ApiErrorNotice error={consentMutation.error} />
        ) : null}
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>Export my data</h3>
          <p className="small muted">
            Download a machine-readable copy of your profile, activity, consents and documents
            straight from the API.
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={exportMutation.status === 'pending'}
            onClick={() => void exportMutation.mutate()}
          >
            {exportMutation.status === 'pending' ? 'Preparing…' : 'Download export'}
          </button>
          {exportMutation.status === 'success' ? (
            <p className="notice notice-success" role="status" style={{ marginTop: '0.75rem' }}>
              <strong>Export ready.</strong> Your data export has been downloaded as JSON.
            </p>
          ) : null}
          {exportMutation.status === 'error' ? (
            <ApiErrorNotice error={exportMutation.error} />
          ) : null}
        </div>
        <div className="card">
          <h3>Delete my account</h3>
          <p className="small muted">
            Deletion removes personal data except records we must retain by law (audit and ledger
            entries, which are pseudonymised).
          </p>
          <CheckRow
            id="confirm-delete"
            checked={confirmDelete}
            onChange={setConfirmDelete}
            label="I understand this action is permanent"
          />
          <button
            type="button"
            className="btn btn-clay"
            disabled={!confirmDelete || deletionMutation.status === 'pending'}
            onClick={() => {
              void deletionMutation.mutate();
              setConfirmDelete(false);
            }}
          >
            {deletionMutation.status === 'pending' ? 'Requesting…' : 'Request deletion'}
          </button>
          {deletionMutation.status === 'success' ? (
            <p className="notice notice-success" role="status" style={{ marginTop: '0.75rem' }}>
              <strong>Deletion requested.</strong> You will be notified when it completes.
            </p>
          ) : null}
          {deletionMutation.status === 'error' ? (
            <ApiErrorNotice error={deletionMutation.error} />
          ) : null}
        </div>
      </div>

      {message === 'consent' ? <QueuedNotice label="Your consent change" /> : null}
      {message === 'deletion' && deletionMutation.status === 'queued' ? (
        <QueuedNotice label="Your deletion request" />
      ) : null}
    </div>
  );
}
