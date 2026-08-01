'use client';

import { useState } from 'react';
import { useAppState } from '@/lib/app-state';
import { usePersistentState } from '@/lib/use-persistent-state';
import { CONSENT_PURPOSES } from '@/lib/content';
import { CheckRow, QueuedNotice } from '@/components/forms';

type ConsentMap = Record<string, boolean>;

const DEFAULT_CONSENTS: ConsentMap = CONSENT_PURPOSES.reduce<ConsentMap>((acc, purpose) => {
  acc[purpose.id] = purpose.locked;
  return acc;
}, {});

export function PrivacyCenter() {
  const { enqueue } = useAppState();
  const [consents, setConsents] = usePersistentState<ConsentMap>('agric.consents', DEFAULT_CONSENTS);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const requestExport = () => {
    enqueue('privacy.export.requested', 'NDPR data export request');
    setMessage('export');
  };

  const requestDeletion = () => {
    if (!confirmDelete) return;
    enqueue('privacy.deletion.requested', 'NDPR account deletion request');
    setMessage('deletion');
    setConfirmDelete(false);
  };

  return (
    <div className="stack-lg">
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
              enqueue(
                checked ? 'privacy.consent.granted' : 'privacy.consent.revoked',
                `Consent ${checked ? 'granted' : 'revoked'}: ${purpose.label}`
              );
              setMessage('consent');
            }}
            label={purpose.locked ? `${purpose.label} (required)` : purpose.label}
            description={purpose.description}
          />
        ))}
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>Export my data</h3>
          <p className="small muted">
            Request a machine-readable copy of your profile, activity, consents and documents. Exports
            are prepared within 72 hours.
          </p>
          <button type="button" className="btn btn-secondary" onClick={requestExport}>
            Request export
          </button>
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
          <button type="button" className="btn btn-clay" disabled={!confirmDelete} onClick={requestDeletion}>
            Request deletion
          </button>
        </div>
      </div>

      {message === 'consent' ? <QueuedNotice label="Your consent change" /> : null}
      {message === 'export' ? <QueuedNotice label="Your data export request" /> : null}
      {message === 'deletion' ? <QueuedNotice label="Your deletion request" /> : null}
    </div>
  );
}
