'use client';

import { useEffect, useState } from 'react';
import { useAppState } from '@/lib/app-state';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  listMyComplianceConsents,
  listMyDataSubjectRequests,
  recordComplianceConsent,
  requestDataErasure,
  requestDataExport,
  revokeComplianceConsent
} from '@/lib/api/endpoints';
import { CONSENT_PURPOSES } from '@/lib/content';
import { CheckRow } from '@/components/forms';
import { ApiErrorNotice, OfflineDataNotice } from '@/components/api-state';

/**
 * NDPA 2023 self-service section of the privacy page (Wave COMP): versioned
 * consent preferences, "Download my data" (s.37) and "Request erasure" (s.38)
 * against the /compliance API. Erasure is honestly presented as a PENDING
 * request — an administrator must approve it before anonymisation runs.
 *
 * The policy version below is a placeholder label for the consent text the
 * DPO publishes; see docs/compliance/ (templates pending legal review).
 */
const CURRENT_POLICY_VERSION = '2026-06 (template — pending DPO review)';

type ConsentMap = Record<string, boolean>;

const DEFAULT_CONSENTS: ConsentMap = CONSENT_PURPOSES.reduce<ConsentMap>((acc, purpose) => {
  acc[purpose.id] = false;
  return acc;
}, {});

export function ComplianceCenter() {
  const { hydrated } = useAppState();
  const [consents, setConsents] = useState<ConsentMap>(DEFAULT_CONSENTS);
  const [confirmErasure, setConfirmErasure] = useState(false);

  const consentsQuery = useApiQuery(
    hydrated ? 'compliance:consents:mine' : null,
    () => listMyComplianceConsents().then((res) => res.data),
    { enabled: hydrated }
  );

  const requestsQuery = useApiQuery(
    hydrated ? 'compliance:dsr:mine' : null,
    () => listMyDataSubjectRequests().then((res) => res.data),
    { enabled: hydrated }
  );

  useEffect(() => {
    if (!consentsQuery.data) return;
    setConsents(() => {
      const next: ConsentMap = { ...DEFAULT_CONSENTS };
      // Latest decision per purpose wins; revoked records count as off.
      for (const record of consentsQuery.data!) {
        next[record.purpose] = !record.revokedAt;
      }
      return next;
    });
  }, [consentsQuery.data]);

  const consentMutation = useApiMutation<{ purpose: string; granted: boolean }, unknown>({
    mutationFn: ({ purpose, granted }) =>
      granted
        ? recordComplianceConsent({
            purpose,
            policyVersion: CURRENT_POLICY_VERSION,
            source: 'privacy-page'
          }).then((res) => res.data)
        : revokeComplianceConsent(purpose).then((res) => res.data)
  });

  const exportMutation = useApiMutation<void, unknown>({
    mutationFn: () => requestDataExport().then((res) => res.data),
    onSuccess: (data) => {
      try {
        const payload = data as { export: unknown };
        const blob = new Blob([JSON.stringify(payload.export, null, 2)], {
          type: 'application/json'
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'agricplatform-ndpa-export.json';
        anchor.click();
        URL.revokeObjectURL(url);
      } catch {
        // Download unsupported — the success notice still confirms the export.
      }
      void requestsQuery.refresh();
    }
  });

  const erasureMutation = useApiMutation<void, unknown>({
    mutationFn: () => requestDataErasure().then((res) => res.data),
    onSuccess: () => void requestsQuery.refresh()
  });

  const pendingErasure = requestsQuery.data?.some(
    (request) => request.type === 'erasure' && request.status === 'pending'
  );

  return (
    <div className="stack-lg">
      {consentsQuery.error ? (
        <OfflineDataNotice>
          Your consent preferences could not be loaded — shown values are defaults, not your saved
          choices.
        </OfflineDataNotice>
      ) : null}

      <div className="card">
        <h3>Consent preferences (NDPA 2023)</h3>
        <p className="small muted">
          Each choice is recorded with the policy version you agreed to and can be withdrawn at any
          time. Policy version: {CURRENT_POLICY_VERSION}.
        </p>
        {CONSENT_PURPOSES.filter((purpose) => !purpose.locked).map((purpose) => (
          <CheckRow
            key={purpose.id}
            id={`ndpa-consent-${purpose.id}`}
            checked={consents[purpose.id] ?? false}
            onChange={(checked) => {
              setConsents((current) => ({ ...current, [purpose.id]: checked }));
              void consentMutation.mutate({ purpose: purpose.id, granted: checked });
            }}
            label={purpose.label}
            description={purpose.description}
          />
        ))}
        {consentMutation.status === 'error' ? <ApiErrorNotice error={consentMutation.error} /> : null}
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>Download my data</h3>
          <p className="small muted">
            NDPA s.37: a machine-readable export of your profile, orders, listings, livestock,
            consents and notifications. Categories the export cannot reach are listed inside it as
            explicit omissions — nothing is silently left out.
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={exportMutation.status === 'pending'}
            onClick={() => void exportMutation.mutate()}
          >
            {exportMutation.status === 'pending' ? 'Preparing…' : 'Download my data'}
          </button>
          {exportMutation.status === 'success' ? (
            <p className="notice notice-success" role="status" style={{ marginTop: '0.75rem' }}>
              <strong>Export ready.</strong> Your NDPA data export has been downloaded as JSON.
            </p>
          ) : null}
          {exportMutation.status === 'error' ? <ApiErrorNotice error={exportMutation.error} /> : null}
        </div>

        <div className="card">
          <h3>Request erasure</h3>
          <p className="small muted">
            NDPA s.38: your name, phone and email are anonymised once an administrator approves the
            request. Records we must keep by law (orders, payments, audit trail) are retained in
            pseudonymised form. Your request shows as <em>pending</em> until then.
          </p>
          {pendingErasure ? (
            <p className="notice notice-info" role="status">
              <strong>Erasure pending.</strong> Your request is awaiting administrator review.
            </p>
          ) : (
            <>
              <CheckRow
                id="confirm-erasure"
                checked={confirmErasure}
                onChange={setConfirmErasure}
                label="I understand my account will be anonymised after approval"
              />
              <button
                type="button"
                className="btn btn-clay"
                disabled={!confirmErasure || erasureMutation.status === 'pending'}
                onClick={() => {
                  void erasureMutation.mutate();
                  setConfirmErasure(false);
                }}
              >
                {erasureMutation.status === 'pending' ? 'Requesting…' : 'Request erasure'}
              </button>
            </>
          )}
          {erasureMutation.status === 'success' && !pendingErasure ? (
            <p className="notice notice-success" role="status" style={{ marginTop: '0.75rem' }}>
              <strong>Request recorded.</strong> It is now pending administrator approval.
            </p>
          ) : null}
          {erasureMutation.status === 'error' ? <ApiErrorNotice error={erasureMutation.error} /> : null}
        </div>
      </div>

      {requestsQuery.data && requestsQuery.data.length > 0 ? (
        <div className="card">
          <h3>My data requests</h3>
          <ul className="small muted" style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {requestsQuery.data.map((request) => (
              <li key={request.id}>
                {request.type === 'export' ? 'Data export' : 'Erasure'} — {request.status}
                {request.note ? ` (${request.note})` : ''} — requested{' '}
                {new Date(request.requestedAt).toLocaleDateString('en-NG')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
