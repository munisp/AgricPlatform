'use client';

import { useState } from 'react';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  SEGMENT_DIMENSIONS,
  MART_NAMES,
  fetchChapterFunnel,
  fetchMemberFunnel,
  fetchRetention,
  fetchSegmentation,
  snapshotMarts
} from '@/lib/api/endpoints';
import type { FunnelStep, MartName, SegmentDimension } from '@/lib/api/endpoints';
import { downloadMartExport } from '@/lib/api/export';
import { ApiErrorNotice, QueryState } from '@/components/api-state';
import { Field, Select, TextInput } from '@/components/forms';
import { Card, EmptyState, StatusBadge } from '@/components/ui';

/**
 * Admin analytics depth surfaces (Wave P6c): segmentation viewer, member +
 * chapter funnel visualisation, weekly retention heatmap and KPI mart
 * snapshot/export controls. All endpoints are admin-gated at the API; the
 * mapped 403 state renders when the preview role lacks access.
 */

const DIMENSION_LABELS: Record<SegmentDimension, string> = {
  state: 'State',
  crop: 'Crop / farming interest',
  role: 'Role',
  kyc_tier: 'KYC tier',
  cohort: 'Signup cohort'
};

const FUNNEL_STEP_LABELS: Record<string, string> = {
  registered: 'Registered',
  profile_complete: 'Profile complete',
  first_course: 'First course',
  first_application: 'First application',
  events: 'Events',
  rsvps: 'RSVPs',
  attendance: 'Attendance'
};

function formatPercent(fraction: number | null): string {
  if (fraction === null) return '—';
  return `${(fraction * 100).toFixed(1)}%`;
}

function humaniseKey(key: string): string {
  return key.replace(/_/g, ' ');
}

/* ---------------------------- segmentation ----------------------------- */

export function SegmentationViewer() {
  const [dimension, setDimension] = useState<SegmentDimension>('state');
  const query = useApiQuery(
    `insights:segmentation:${dimension}`,
    () => fetchSegmentation(dimension).then((res) => res.data)
  );

  return (
    <Card title="Member segmentation">
      <div className="form-grid cols-2">
        <Field id="seg-dimension" label="Segment by">
          <Select
            id="seg-dimension"
            value={dimension}
            onChange={(e) => setDimension(e.target.value as SegmentDimension)}
          >
            {SEGMENT_DIMENSIONS.map((entry) => (
              <option key={entry} value={entry}>
                {DIMENSION_LABELS[entry]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        data={query.data?.segments}
        onRetry={query.refresh}
        empty={<EmptyState title="No members in this dimension yet" />}
      >
        <p className="small muted">
          {(query.data?.total ?? 0).toLocaleString('en-NG')} members segmented by{' '}
          {DIMENSION_LABELS[dimension].toLowerCase()}. Members can appear in several crop segments,
          so percentages may sum above 100.
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Segment</th>
                <th scope="col">Members</th>
                <th scope="col">% of members</th>
              </tr>
            </thead>
            <tbody>
              {(query.data?.segments ?? []).map((segment) => (
                <tr key={segment.key}>
                  <td>{humaniseKey(segment.key)}</td>
                  <td>{segment.count.toLocaleString('en-NG')}</td>
                  <td>{segment.percentage.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
    </Card>
  );
}

/* ------------------------------- funnels ------------------------------- */

function FunnelBars({ steps, label }: { steps: FunnelStep[]; label: string }) {
  const max = Math.max(1, ...steps.map((step) => step.count));
  return (
    <ol className="funnel" aria-label={label} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {steps.map((step) => (
        <li key={step.key} className="funnel-row">
          <span className="funnel-label">{FUNNEL_STEP_LABELS[step.key] ?? humaniseKey(step.key)}</span>
          <span className="funnel-track">
            <span
              className="funnel-bar"
              style={{ width: `${Math.max(2, (step.count / max) * 100)}%` }}
              aria-hidden="true"
            />
          </span>
          <span className="funnel-value">
            {step.count.toLocaleString('en-NG')}
            <span className="small muted">
              {' '}
              · {formatPercent(step.conversionFromFirst)} of first
              {step.conversionFromPrevious !== null
                ? ` · ${formatPercent(step.conversionFromPrevious)} from previous`
                : ''}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function FunnelVisualisation() {
  const [windowDays, setWindowDays] = useState(90);
  const memberQuery = useApiQuery(
    `insights:funnel:${windowDays}`,
    () => fetchMemberFunnel({ windowDays }).then((res) => res.data)
  );
  const chapterQuery = useApiQuery(
    'insights:funnel:chapters',
    () => fetchChapterFunnel().then((res) => res.data)
  );

  const chapter = chapterQuery.data;
  const chapterSteps: FunnelStep[] | undefined = chapter
    ? [
        { key: 'events', count: chapter.events, conversionFromPrevious: null, conversionFromFirst: 1 },
        {
          key: 'rsvps',
          count: chapter.rsvps,
          conversionFromPrevious: chapter.rsvpPerEvent,
          conversionFromFirst: chapter.rsvpPerEvent
        },
        {
          key: 'attendance',
          count: chapter.attendances,
          conversionFromPrevious: chapter.attendanceRate,
          conversionFromFirst:
            chapter.events > 0 ? chapter.attendances / chapter.events : 0
        }
      ]
    : undefined;

  return (
    <div className="grid grid-2">
      <Card title="Member funnel">
        <div className="form-grid cols-2">
          <Field id="funnel-window" label="Trailing window">
            <Select
              id="funnel-window"
              value={String(windowDays)}
              onChange={(e) => setWindowDays(Number(e.target.value))}
            >
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="365">Last 365 days</option>
            </Select>
          </Field>
        </div>
        <QueryState
          isLoading={memberQuery.isLoading}
          error={memberQuery.error}
          data={memberQuery.data}
          onRetry={memberQuery.refresh}
          empty={<EmptyState title="No registrations in this window" />}
        >
          <FunnelBars steps={memberQuery.data ?? []} label="Registration to first application funnel" />
        </QueryState>
      </Card>

      <Card title="Chapter funnel">
        <p className="small muted">Events → RSVPs → attendance across all chapters.</p>
        <QueryState
          isLoading={chapterQuery.isLoading}
          error={chapterQuery.error}
          data={chapterSteps}
          onRetry={chapterQuery.refresh}
          empty={<EmptyState title="No chapter events yet" />}
        >
          <FunnelBars steps={chapterSteps ?? []} label="Chapter events to attendance funnel" />
        </QueryState>
      </Card>
    </div>
  );
}

/* ------------------------------- retention ----------------------------- */

/** Green heat shading on the card background; darker = better retention. */
function retentionCellStyle(fraction: number | null): { background?: string } {
  if (fraction === null) return {};
  const alpha = 0.06 + fraction * 0.62;
  return { background: `rgba(60, 111, 77, ${alpha.toFixed(3)})` };
}

export function RetentionHeatmap() {
  const [weeks, setWeeks] = useState(12);
  const query = useApiQuery(
    `insights:retention:${weeks}`,
    () => fetchRetention({ weeks }).then((res) => res.data)
  );

  const matrix = query.data;
  const maxOffset = Math.max(0, ...(matrix?.rows ?? []).map((row) => row.retention.length - 1));

  return (
    <Card title="Weekly retention">
      <div className="form-grid cols-2">
        <Field id="retention-weeks" label="Cohort weeks">
          <Select
            id="retention-weeks"
            value={String(weeks)}
            onChange={(e) => setWeeks(Number(e.target.value))}
          >
            <option value="8">8 weeks</option>
            <option value="12">12 weeks</option>
            <option value="26">26 weeks</option>
          </Select>
        </Field>
      </div>
      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        data={matrix?.rows}
        onRetry={query.refresh}
        empty={<EmptyState title="No signup cohorts in this range" />}
      >
        <p className="small muted">
          Signup cohorts (Africa/Lagos, Monday week start). The right-most week is the current
          partial week. Darker cells mean more of the cohort was still active.
        </p>
        <div className="table-wrap">
          <table className="table retention-table">
            <thead>
              <tr>
                <th scope="col">Cohort week</th>
                <th scope="col">Size</th>
                {Array.from({ length: maxOffset + 1 }, (_, offset) => (
                  <th scope="col" key={offset}>
                    W{offset}
                    {offset === maxOffset ? (
                      <>
                        {' '}
                        <StatusBadge tone="warning">partial</StatusBadge>
                      </>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(matrix?.rows ?? []).map((row) => (
                <tr key={row.cohortWeek}>
                  <td>{row.cohortWeek}</td>
                  <td>{row.size.toLocaleString('en-NG')}</td>
                  {Array.from({ length: maxOffset + 1 }, (_, offset) => {
                    const value = row.retention[offset] ?? null;
                    const retained = row.retained[offset] ?? null;
                    return (
                      <td
                        key={offset}
                        style={retentionCellStyle(value)}
                        title={
                          value !== null && retained !== null
                            ? `${retained.toLocaleString('en-NG')} of ${row.size.toLocaleString('en-NG')} still active`
                            : 'Week not reached yet'
                        }
                      >
                        {value !== null ? formatPercent(value) : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
    </Card>
  );
}

/* ------------------------------ data marts ----------------------------- */

const MART_LABELS: Record<MartName, string> = {
  member_kpis: 'Member KPIs',
  marketplace: 'Marketplace daily',
  learning: 'Learning daily'
};

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function MartControls() {
  const [snapshotDate, setSnapshotDate] = useState(isoToday);
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [exportState, setExportState] = useState<Record<string, 'idle' | 'saving' | 'saved' | 'failed'>>({});

  const snapshot = useApiMutation<{ date?: string }, unknown>({
    mutationFn: ({ date }) => snapshotMarts({ date }).then((res) => res.data)
  });

  const exportMart = async (mart: MartName) => {
    setExportState((prev) => ({ ...prev, [mart]: 'saving' }));
    try {
      await downloadMartExport(mart, {
        from: range.from || undefined,
        to: range.to || undefined
      });
      setExportState((prev) => ({ ...prev, [mart]: 'saved' }));
    } catch {
      setExportState((prev) => ({ ...prev, [mart]: 'failed' }));
    }
  };

  return (
    <div className="grid grid-2">
      <Card title="Mart snapshot">
        <p className="small muted">
          Recomputes all KPI marts for one Lagos calendar day and upserts them — idempotent, safe
          to re-run for backfills. Audit-logged.
        </p>
        <div className="form-grid cols-2">
          <Field id="mart-snapshot-date" label="Snapshot date">
            <TextInput
              id="mart-snapshot-date"
              type="date"
              value={snapshotDate}
              onChange={(e) => setSnapshotDate(e.target.value)}
            />
          </Field>
        </div>
        <div className="cluster" style={{ justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!snapshotDate || snapshot.status === 'pending'}
            onClick={() => void snapshot.mutate({ date: snapshotDate })}
          >
            {snapshot.status === 'pending' ? 'Running snapshot…' : 'Run snapshot'}
          </button>
        </div>
        {snapshot.status === 'success' ? (
          <div className="notice notice-success" role="status">
            <strong>Snapshot saved.</strong> Marts recomputed for {snapshotDate}.
          </div>
        ) : null}
        {snapshot.status === 'error' ? <ApiErrorNotice error={snapshot.error} /> : null}
      </Card>

      <Card title="Mart CSV export">
        <p className="small muted">
          Columnar-friendly CSV per mart (parquet-ready, snapshot_date partition column). Leave the
          range empty for all dates. Every export is audit-logged.
        </p>
        <div className="form-grid cols-2">
          <Field id="mart-from" label="From (optional)">
            <TextInput
              id="mart-from"
              type="date"
              value={range.from}
              onChange={(e) => setRange((prev) => ({ ...prev, from: e.target.value }))}
            />
          </Field>
          <Field id="mart-to" label="To (optional)">
            <TextInput
              id="mart-to"
              type="date"
              value={range.to}
              onChange={(e) => setRange((prev) => ({ ...prev, to: e.target.value }))}
            />
          </Field>
        </div>
        <ul className="row-list">
          {MART_NAMES.map((mart) => {
            const state = exportState[mart] ?? 'idle';
            return (
              <li className="row-item" key={mart}>
                <div className="row-main">
                  <div className="row-title">{MART_LABELS[mart]}</div>
                  <div className="small muted">
                    mart-{mart.replace(/_/g, '-')}.csv
                    {state === 'saved' ? ' · downloaded' : ''}
                    {state === 'failed' ? ' · export failed — try again' : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  disabled={state === 'saving'}
                  onClick={() => void exportMart(mart)}
                >
                  {state === 'saving' ? 'Preparing…' : 'Download CSV'}
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
