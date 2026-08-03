import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import {
  AnalyticsSummaryCards,
  DailyMetricsTable,
  LakehouseExportPanel,
  ProjectionPanel
} from '@/components/admin-analytics-live';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <AppProvider>
      <I18nProvider>{ui}</I18nProvider>
    </AppProvider>
  );
}

const SUMMARY = {
  gmvKobo: 9_000_000,
  ordersCount: 3,
  escrowHeldKobo: 4_500_000,
  livestockRegistered: 7,
  members: 12,
  listings: 5,
  lastProjectionAt: '2026-08-06T00:00:00.000Z',
  generatedAt: '2026-08-06T01:00:00.000Z'
};

const DAILY = [
  {
    metricDate: '2026-08-01',
    ordersGmvKobo: 9_000_000,
    ordersCount: 2,
    activeFarmers: 2,
    escrowHeldKobo: 4_500_000,
    livestockRegistered: 5
  },
  {
    metricDate: '2026-08-02',
    ordersGmvKobo: 0,
    ordersCount: 0,
    activeFarmers: 0,
    escrowHeldKobo: 4_500_000,
    livestockRegistered: 2
  }
];

const PROJECTION = { scanned: 10, applied: 4, skipped: 6, recomputedDates: ['2026-08-01'], ranAt: '2026-08-06T01:00:00.000Z' };

describe('Admin analytics marts page', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/api/v1/analytics/metrics/summary')) {
        return jsonResponse({ data: SUMMARY });
      }
      if (path.endsWith('/api/v1/analytics/metrics/daily')) {
        return jsonResponse({ data: DAILY });
      }
      if (path.endsWith('/api/v1/analytics/project')) {
        return jsonResponse({ data: PROJECTION });
      }
      return jsonResponse({ statusCode: 404, message: 'not found' }, 404);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders summary stat cards from the live API', async () => {
    renderWithProviders(<AnalyticsSummaryCards />);
    await waitFor(() => expect(screen.getByText('₦90,000')).toBeTruthy());
    expect(screen.getByText('₦45,000')).toBeTruthy(); // escrow exposure
    expect(screen.getByText('7')).toBeTruthy(); // livestock registered
    expect(screen.getByText(/Last projection/)).toBeTruthy();
  });

  it('shows the offline notice with fixture data when the API is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    renderWithProviders(<AnalyticsSummaryCards />);
    await waitFor(() =>
      expect(screen.getByText(/showing reference metrics/)).toBeTruthy()
    );
  });

  it('maps a 403 to the no-access state instead of fixtures', async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({ statusCode: 403, message: 'forbidden' }, 403)
    );
    renderWithProviders(<AnalyticsSummaryCards />);
    await waitFor(() => expect(screen.getByText('No access')).toBeTruthy());
  });

  it('renders the daily metrics table with Lagos-day rows', async () => {
    renderWithProviders(<DailyMetricsTable />);
    await waitFor(() => expect(screen.getByText('2026-08-01')).toBeTruthy());
    expect(screen.getByText('2026-08-02')).toBeTruthy();
    expect(screen.getByText('9,000,000')).toBeTruthy();
  });

  it('re-queries with the applied date range', async () => {
    renderWithProviders(<DailyMetricsTable />);
    await waitFor(() => expect(screen.getByText('2026-08-01')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-02' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-02' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(
        calls.some(
          (url) => url.includes('/api/v1/analytics/metrics/daily') && url.includes('from=2026-08-02') && url.includes('to=2026-08-02')
        )
      ).toBe(true);
    });
  });

  it('runs a projection and shows the run result', async () => {
    renderWithProviders(<ProjectionPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Run projection now' }));
    await waitFor(() =>
      expect(screen.getByText(/Scanned 10 · applied 4 · skipped 6/)).toBeTruthy()
    );
    const calls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calls.some((url) => url.includes('/api/v1/analytics/project'))).toBe(true);
  });

  it('offers both fact CSV exports', () => {
    renderWithProviders(<ProjectionPanel />);
    expect(screen.getByRole('button', { name: 'Download fact_orders.csv' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download fact_payments.csv' })).toBeTruthy();
  });
});

const LAKEHOUSE_MANIFEST = {
  runId: 'a1b2c3d4-0000-4000-8000-000000000000',
  runDate: '2026-08-06',
  bucket: 'agric-lakehouse',
  prefix: 'lakehouse',
  format: 'parquet',
  startedAt: '2026-08-06T00:00:00.000Z',
  finishedAt: '2026-08-06T00:00:01.000Z',
  tables: [
    {
      table: 'fact_orders',
      rows: 3,
      files: [{ key: 'lakehouse/fact_orders/dt=2026-08-06/part-x-00000.parquet', bytes: 2048, sha256: 'abc' }]
    }
  ],
  totalRows: 3,
  totalBytes: 2048
};

describe('Lakehouse export card', () => {
  const fetchMock = vi.fn();

  function mockStatus(status: unknown, postResponse?: unknown) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/api/v1/analytics/export/last')) {
        return jsonResponse({ data: status });
      }
      if (path.endsWith('/api/v1/analytics/export') && init?.method === 'POST') {
        return postResponse
          ? Promise.resolve(postResponse as Response)
          : jsonResponse({ data: LAKEHOUSE_MANIFEST });
      }
      return jsonResponse({ statusCode: 404, message: 'not found' }, 404);
    });
  }

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the honest disabled state when LAKEHOUSE_ENABLED=false', async () => {
    mockStatus({
      enabled: false,
      reason: 'LAKEHOUSE_ENABLED is not true — the lakehouse exporter is disabled on this API.',
      prefix: 'lakehouse',
      manifest: null
    });
    renderWithProviders(<LakehouseExportPanel />);
    await waitFor(() =>
      expect(screen.getByText(/lakehouse exporter is disabled/)).toBeTruthy()
    );
    expect(screen.queryByRole('button', { name: 'Run lakehouse export' })).toBeNull();
  });

  it('shows the last run manifest when enabled', async () => {
    mockStatus({ enabled: true, bucket: 'agric-lakehouse', prefix: 'lakehouse', manifest: LAKEHOUSE_MANIFEST });
    renderWithProviders(<LakehouseExportPanel />);
    await waitFor(() => expect(screen.getByText(/Last run a1b2c3d4/)).toBeTruthy());
    expect(screen.getByText(/2026-08-06 · 3 rows · 2048 bytes across 1 tables/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run lakehouse export' })).toBeTruthy();
  });

  it('shows the honest empty state before the first run', async () => {
    mockStatus({ enabled: true, bucket: 'agric-lakehouse', prefix: 'lakehouse', manifest: null });
    renderWithProviders(<LakehouseExportPanel />);
    await waitFor(() => expect(screen.getByText('No export run yet.')).toBeTruthy());
  });

  it('trigger button posts to /analytics/export and shows the run result', async () => {
    mockStatus({ enabled: true, bucket: 'agric-lakehouse', prefix: 'lakehouse', manifest: null });
    renderWithProviders(<LakehouseExportPanel />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run lakehouse export' })).toBeTruthy()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run lakehouse export' }));
    await waitFor(() =>
      expect(screen.getByText(/Export complete: run a1b2c3d4/)).toBeTruthy()
    );
    const calls = fetchMock.mock.calls.map((call) => [String(call[0]), call[1]] as const);
    expect(
      calls.some(
        ([url, init]) =>
          url.includes('/api/v1/analytics/export') &&
          (init as RequestInit | undefined)?.method === 'POST'
      )
    ).toBe(true);
  });
});
