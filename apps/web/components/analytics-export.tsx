'use client';

import { useState } from 'react';
import { downloadAnalyticsExport } from '@/lib/api/export';
import type { AnalyticsExportFormat } from '@/lib/api/export';
import { ApiErrorNotice } from '@/components/api-state';
import { StatusBadge } from '@/components/ui';

type ExportState =
  | { status: 'idle' }
  | { status: 'pending'; format: AnalyticsExportFormat }
  | { status: 'success'; fileName: string }
  | { status: 'error'; error: unknown };

/**
 * Admin analytics export (GET /analytics/export?format=csv|pdf). Triggers a
 * real file download; failures are explicit with a retry — never silent.
 */
export function AnalyticsExportButtons() {
  const [state, setState] = useState<ExportState>({ status: 'idle' });

  const run = async (format: AnalyticsExportFormat) => {
    setState({ status: 'pending', format });
    try {
      const fileName = await downloadAnalyticsExport(format);
      setState({ status: 'success', fileName });
    } catch (error) {
      setState({ status: 'error', error });
    }
  };

  const pending = state.status === 'pending';

  return (
    <div className="stack">
      <div className="cluster">
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending}
          onClick={() => void run('csv')}
        >
          {pending && state.format === 'csv' ? 'Preparing CSV…' : 'Export CSV'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={pending}
          onClick={() => void run('pdf')}
        >
          {pending && state.format === 'pdf' ? 'Preparing PDF…' : 'Export PDF'}
        </button>
      </div>
      {state.status === 'success' ? (
        <StatusBadge tone="success">downloaded {state.fileName}</StatusBadge>
      ) : null}
      {state.status === 'error' ? (
        <ApiErrorNotice
          error={state.error}
          onRetry={() => void run('csv')}
        />
      ) : null}
    </div>
  );
}
