'use client';

import { useState } from 'react';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import { ForbiddenError, UnauthorizedError } from '@/lib/api/errors';
import {
  fetchAnalyticsSummary,
  fetchDailyMetrics,
  fetchLakehouseExportStatus,
  runLakehouseExport,
  runProjection,
  STAR_FACTS,
  type AnalyticsSummary,
  type DailyMetric,
  type LakehouseManifest,
  type StarFact
} from '@/lib/api/endpoints';
import { downloadFactExport } from '@/lib/api/export';
import { useT } from '@/lib/i18n';
import { ApiErrorNotice, OfflineDataNotice, QueryState } from '@/components/api-state';
import { Field, TextInput } from '@/components/forms';
import { Card, EmptyState, formatKobo } from '@/components/ui';

/**
 * Wave B admin analytics surfaces: headline star-mart summary, daily rollup
 * table, projection trigger and lakehouse-handoff CSV exports. All endpoints
 * are role-gated at the API (admin/regulator; projection admin-only) — a 403
 * maps to the no-access state. The mart data itself is honest: everything
 * shown comes from PostgreSQL marts, no lakehouse exists.
 */

/* Offline fallback fixtures only — clearly labelled by OfflineDataNotice. */
const FALLBACK_SUMMARY: AnalyticsSummary = {
  gmvKobo: 18_450_000_00,
  ordersCount: 132,
  escrowHeldKobo: 4_200_000_00,
  livestockRegistered: 861,
  members: 2_480,
  listings: 517,
  lastProjectionAt: null,
  generatedAt: '2026-01-01T00:00:00.000Z'
};

const FALLBACK_DAILY: DailyMetric[] = [
  {
    metricDate: '2026-08-01',
    ordersGmvKobo: 9_000_000,
    ordersCount: 12,
    activeFarmers: 9,
    escrowHeldKobo: 4_200_000,
    livestockRegistered: 21
  },
  {
    metricDate: '2026-08-02',
    ordersGmvKobo: 6_500_000,
    ordersCount: 8,
    activeFarmers: 7,
    escrowHeldKobo: 3_900_000,
    livestockRegistered: 14
  }
];

/** RBAC errors must surface the no-access state, never reference fixtures. */
function isAuthzError(error: unknown): boolean {
  return error instanceof ForbiddenError || error instanceof UnauthorizedError;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <p className="small muted" style={{ marginBottom: '0.25rem' }}>
        {label}
      </p>
      <p style={{ fontWeight: 800, fontSize: '1.25rem', margin: 0 }}>{value}</p>
    </div>
  );
}

export function AnalyticsSummaryCards() {
  const { t } = useT();
  const query = useApiQuery('admin:analytics:summary', () => fetchAnalyticsSummary().then((res) => res.data), {
    fallbackData: FALLBACK_SUMMARY,
    staleTimeMs: 60_000
  });
  const summary = isAuthzError(query.error) ? undefined : query.data;

  return (
    <>
      {query.source === 'fallback' && query.error && !isAuthzError(query.error) ? (
        <OfflineDataNotice>{t('adminAnalytics.offlineNotice')}</OfflineDataNotice>
      ) : null}
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' && !isAuthzError(query.error) ? undefined : query.error}
        data={summary}
        onRetry={query.refresh}
      >
        {summary ? (
          <>
            <div className="grid grid-3">
              <StatCard label={t('adminAnalytics.gmv')} value={formatKobo(summary.gmvKobo)} />
              <StatCard label={t('adminAnalytics.orders')} value={summary.ordersCount.toLocaleString('en-NG')} />
              <StatCard label={t('adminAnalytics.escrowExposure')} value={formatKobo(summary.escrowHeldKobo)} />
              <StatCard
                label={t('adminAnalytics.livestock')}
                value={summary.livestockRegistered.toLocaleString('en-NG')}
              />
              <StatCard label={t('adminAnalytics.members')} value={summary.members.toLocaleString('en-NG')} />
              <StatCard label={t('adminAnalytics.listings')} value={summary.listings.toLocaleString('en-NG')} />
            </div>
            <p className="small muted">
              {summary.lastProjectionAt
                ? t('adminAnalytics.lastProjection', {
                    time: new Date(summary.lastProjectionAt).toLocaleString('en-NG')
                  })
                : t('adminAnalytics.neverProjected')}
            </p>
          </>
        ) : null}
      </QueryState>
    </>
  );
}

export function DailyMetricsTable() {
  const { t } = useT();
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [applied, setApplied] = useState<{ from?: string; to?: string }>({});
  const query = useApiQuery(
    `admin:analytics:daily:${applied.from ?? ''}:${applied.to ?? ''}`,
    () => fetchDailyMetrics(applied).then((res) => res.data),
    { fallbackData: FALLBACK_DAILY, staleTimeMs: 30_000 }
  );

  return (
    <Card title={t('adminAnalytics.dailyTitle')}>
      {query.source === 'fallback' && query.error && !isAuthzError(query.error) ? (
        <OfflineDataNotice>{t('adminAnalytics.offlineNotice')}</OfflineDataNotice>
      ) : null}
      <div className="form-grid cols-2">
        <Field id="analytics-from" label={t('adminAnalytics.fromLabel')}>
          <TextInput
            id="analytics-from"
            type="date"
            value={range.from}
            onChange={(e) => setRange((prev) => ({ ...prev, from: e.target.value }))}
          />
        </Field>
        <Field id="analytics-to" label={t('adminAnalytics.toLabel')}>
          <TextInput
            id="analytics-to"
            type="date"
            value={range.to}
            onChange={(e) => setRange((prev) => ({ ...prev, to: e.target.value }))}
          />
        </Field>
      </div>
      <div className="cluster" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={() =>
            setApplied({ from: range.from || undefined, to: range.to || undefined })
          }
        >
          {t('adminAnalytics.apply')}
        </button>
      </div>
      <QueryState
        isLoading={query.isLoading}
        error={query.source === 'fallback' && !isAuthzError(query.error) ? undefined : query.error}
        data={isAuthzError(query.error) ? undefined : query.data}
        onRetry={query.refresh}
        empty={<EmptyState title={t('adminAnalytics.empty')} />}
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('adminAnalytics.date')}</th>
                <th scope="col">{t('adminAnalytics.gmvKobo')}</th>
                <th scope="col">{t('adminAnalytics.ordersCount')}</th>
                <th scope="col">{t('adminAnalytics.activeFarmers')}</th>
                <th scope="col">{t('adminAnalytics.escrowHeld')}</th>
                <th scope="col">{t('adminAnalytics.livestockRegistered')}</th>
              </tr>
            </thead>
            <tbody>
              {(query.data ?? []).map((row) => (
                <tr key={row.metricDate}>
                  <td>{row.metricDate}</td>
                  <td>{row.ordersGmvKobo.toLocaleString('en-NG')}</td>
                  <td>{row.ordersCount}</td>
                  <td>{row.activeFarmers}</td>
                  <td>{row.escrowHeldKobo.toLocaleString('en-NG')}</td>
                  <td>{row.livestockRegistered}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
    </Card>
  );
}

const FACT_LABELS: Record<StarFact, 'adminAnalytics.exportFactOrders' | 'adminAnalytics.exportFactPayments'> = {
  fact_orders: 'adminAnalytics.exportFactOrders',
  fact_payments: 'adminAnalytics.exportFactPayments'
};

export function ProjectionPanel() {
  const { t } = useT();
  const [exportState, setExportState] = useState<Record<string, 'idle' | 'saving' | 'saved' | 'failed'>>({});
  const projection = useApiMutation<void, unknown>({
    mutationFn: () => runProjection().then((res) => res.data)
  });
  const result = projection.data as
    | { scanned: number; applied: number; skipped: number; recomputedDates: string[] }
    | undefined;

  const exportFact = async (fact: StarFact) => {
    setExportState((prev) => ({ ...prev, [fact]: 'saving' }));
    try {
      await downloadFactExport(fact);
      setExportState((prev) => ({ ...prev, [fact]: 'saved' }));
    } catch {
      setExportState((prev) => ({ ...prev, [fact]: 'failed' }));
    }
  };

  return (
    <div className="grid grid-2">
      <Card title={t('adminAnalytics.projectTitle')}>
        <p className="small muted">{t('adminAnalytics.projectDescription')}</p>
        <div className="cluster" style={{ justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={projection.status === 'pending'}
            onClick={() => void projection.mutate()}
          >
            {projection.status === 'pending'
              ? t('adminAnalytics.running')
              : t('adminAnalytics.runProjection')}
          </button>
        </div>
        {projection.status === 'success' && result ? (
          <div className="notice notice-success" role="status">
            {t('adminAnalytics.projectResult', {
              scanned: result.scanned,
              applied: result.applied,
              skipped: result.skipped,
              dates: result.recomputedDates.join(', ') || '—'
            })}
          </div>
        ) : null}
        {projection.status === 'error' ? <ApiErrorNotice error={projection.error} /> : null}
      </Card>

      <Card title={t('adminAnalytics.exportTitle')}>
        <p className="small muted">{t('adminAnalytics.exportDescription')}</p>
        <div className="cluster">
          {STAR_FACTS.map((fact) => (
            <button
              key={fact}
              type="button"
              className="btn btn-ghost btn-small"
              disabled={exportState[fact] === 'saving'}
              onClick={() => void exportFact(fact)}
            >
              {exportState[fact] === 'saving' ? '…' : t(FACT_LABELS[fact])}
            </button>
          ))}
        </div>
        {STAR_FACTS.some((fact) => exportState[fact] === 'failed') ? (
          <p className="small" role="alert">
            Export failed — try again.
          </p>
        ) : null}
      </Card>
    </div>
  );
}

/**
 * Lakehouse export card: trigger POST /analytics/export and show the last
 * run's manifest from GET /analytics/export/last. When the API reports
 * enabled=false (LAKEHOUSE_ENABLED off or misconfigured outside production)
 * the honest disabled reason is shown instead of any fake state.
 */
export function LakehouseExportPanel() {
  const { t } = useT();
  const statusQuery = useApiQuery(
    'admin:analytics:lakehouse-last',
    () => fetchLakehouseExportStatus().then((res) => res.data),
    { staleTimeMs: 30_000 }
  );
  const exportRun = useApiMutation<void, LakehouseManifest>({
    mutationFn: () => runLakehouseExport().then((res) => res.data)
  });
  const status = isAuthzError(statusQuery.error) ? undefined : statusQuery.data;
  const manifest = exportRun.data ?? status?.manifest ?? null;

  return (
    <Card title={t('adminAnalytics.lakehouseTitle')}>
      <p className="small muted">{t('adminAnalytics.lakehouseDescription')}</p>
      <QueryState
        isLoading={statusQuery.isLoading}
        error={statusQuery.error}
        data={status}
        onRetry={statusQuery.refresh}
      >
        {status ? (
          status.enabled ? (
            <>
              <div className="cluster" style={{ justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={exportRun.status === 'pending'}
                  onClick={() => {
                    void exportRun.mutate().then(() => statusQuery.refresh());
                  }}
                >
                  {exportRun.status === 'pending'
                    ? t('adminAnalytics.lakehouseRunning')
                    : t('adminAnalytics.lakehouseRun')}
                </button>
              </div>
              {manifest ? (
                <p className="small muted" role="status">
                  {t('adminAnalytics.lakehouseLastRun', {
                    runId: manifest.runId.slice(0, 8),
                    date: manifest.runDate,
                    rows: manifest.totalRows,
                    bytes: manifest.totalBytes,
                    tables: manifest.tables.length
                  })}
                </p>
              ) : (
                <p className="small muted">{t('adminAnalytics.lakehouseNever')}</p>
              )}
            </>
          ) : (
            <div className="notice" role="status">
              {status.reason ?? t('adminAnalytics.lakehouseDisabled')}
            </div>
          )
        ) : null}
      </QueryState>
      {exportRun.status === 'success' && exportRun.data ? (
        <div className="notice notice-success" role="status">
          {t('adminAnalytics.lakehouseRunComplete', {
            runId: exportRun.data.runId.slice(0, 8),
            date: exportRun.data.runDate,
            rows: exportRun.data.totalRows,
            tables: exportRun.data.tables.length
          })}
        </div>
      ) : null}
      {exportRun.status === 'error' ? <ApiErrorNotice error={exportRun.error} /> : null}
    </Card>
  );
}
