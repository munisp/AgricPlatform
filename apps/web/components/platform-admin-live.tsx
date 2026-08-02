'use client';

import { useState } from 'react';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  adminDeleteFeatureFlag,
  adminListFeatureFlags,
  adminUpsertFeatureFlag,
  adminVerifyAuditLog,
  fetchModuleHealth,
  type AuditVerificationResult,
  type FeatureFlag
} from '@/lib/api/endpoints';
import { OfflineDataNotice, QueryState } from '@/components/api-state';
import { useT } from '@/lib/i18n';

/**
 * Wave P admin surfaces: per-module readiness matrix, feature-flag admin,
 * and audit hash-chain verification. All three are role-gated server-side;
 * when the caller lacks the admin role the API returns 403 and the panels
 * show the no-access state (no fixtures for operational data).
 */

export function ModuleStatusMatrix() {
  const { t } = useT();
  const query = useApiQuery('admin:module-health', () => fetchModuleHealth(), {
    staleTimeMs: 30_000
  });
  return (
    <div data-testid="module-status">
      {query.error ? (
        <OfflineDataNotice>Module status unavailable — admin role required.</OfflineDataNotice>
      ) : null}
      <QueryState isLoading={query.isLoading} error={undefined} data={query.data} onRetry={query.refresh}>
        {query.data ? (
          <>
            <p className="small muted">
              {t('adminStatus.checkedAt', { time: query.data.checkedAt })}
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Module</th>
                  <th>Status</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {query.data.modules.map((probe) => (
                  <tr key={probe.name} data-testid={`probe-${probe.name}`}>
                    <td>{probe.name}</td>
                    <td>{probe.status}</td>
                    <td className="small muted">
                      {probe.error ?? (probe.details ? JSON.stringify(probe.details) : '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </QueryState>
    </div>
  );
}

export function FeatureFlagPanel() {
  const { t } = useT();
  const query = useApiQuery('admin:feature-flags', () => adminListFeatureFlags().then((r) => r.data), {
    staleTimeMs: 15_000
  });
  const [draft, setDraft] = useState<FeatureFlag>({
    key: '',
    enabled: true,
    roleAllowlist: [],
    percentage: 100,
    description: '',
    updatedAt: ''
  });
  const save = useApiMutation({
    mutationFn: (flag: FeatureFlag) =>
      adminUpsertFeatureFlag({
        key: flag.key,
        enabled: flag.enabled,
        roleAllowlist: flag.roleAllowlist,
        percentage: flag.percentage,
        description: flag.description
      })
  });

  return (
    <div data-testid="feature-flag-panel">
      {query.error ? (
        <OfflineDataNotice>Feature flags unavailable — admin role required.</OfflineDataNotice>
      ) : null}
      <QueryState isLoading={query.isLoading} error={undefined} data={query.data} onRetry={query.refresh}>
        <ul>
          {(query.data ?? []).map((flag) => (
            <li key={flag.key}>
              <strong>{flag.key}</strong> — {flag.enabled ? 'on' : 'off'}, {flag.percentage}%
              {flag.roleAllowlist.length > 0 ? ` (${flag.roleAllowlist.join(', ')})` : ''}{' '}
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => void adminDeleteFeatureFlag(flag.key).then(() => query.refresh())}
              >
                {t('adminFlags.delete')}
              </button>
            </li>
          ))}
        </ul>
      </QueryState>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save.mutate(draft).then(() => query.refresh());
        }}
      >
        <label className="small" htmlFor="flag-key">
          {t('adminFlags.key')}
        </label>
        <input
          id="flag-key"
          value={draft.key}
          onChange={(event) => setDraft({ ...draft, key: event.target.value })}
          required
        />
        <label className="small" htmlFor="flag-percentage">
          {t('adminFlags.percentage')}
        </label>
        <input
          id="flag-percentage"
          type="number"
          min={0}
          max={100}
          value={draft.percentage}
          onChange={(event) => setDraft({ ...draft, percentage: Number(event.target.value) })}
        />
        <label className="small" htmlFor="flag-enabled">
          {t('adminFlags.enabled')}
        </label>
        <input
          id="flag-enabled"
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
        />
        <button type="submit" className="btn btn-primary btn-small">
          {t('adminFlags.save')}
        </button>
      </form>
      {save.error ? <p className="small muted">Save failed — admin role required.</p> : null}
    </div>
  );
}

export function AuditVerifyPanel() {
  const { t } = useT();
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [result, setResult] = useState<AuditVerificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await adminVerifyAuditLog({
        fromId: fromId || undefined,
        toId: toId || undefined
      });
      setResult(res.data);
    } catch {
      setError('verify-failed');
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div data-testid="audit-verify-panel">
      <label className="small" htmlFor="audit-from">
        {t('adminAuditVerify.fromId')}
      </label>
      <input id="audit-from" value={fromId} onChange={(event) => setFromId(event.target.value)} />
      <label className="small" htmlFor="audit-to">
        {t('adminAuditVerify.toId')}
      </label>
      <input id="audit-to" value={toId} onChange={(event) => setToId(event.target.value)} />
      <button
        type="button"
        className="btn btn-primary btn-small"
        disabled={running}
        onClick={() => void run()}
      >
        {t('adminAuditVerify.run')}
      </button>
      {error ? (
        <p className="small" data-testid="audit-verify-error">
          {t('adminAuditVerify.invalidRange')}
        </p>
      ) : null}
      {result ? (
        <p className="small" data-testid="audit-verify-result">
          {result.valid
            ? t('adminAuditVerify.valid', { checked: result.checked ?? 0 })
            : t('adminAuditVerify.broken', { id: result.brokenAt ?? '?' })}
        </p>
      ) : null}
    </div>
  );
}
