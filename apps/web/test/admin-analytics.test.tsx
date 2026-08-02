import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import {
  AnalyticsSummaryCards,
  DailyMetricsTable,
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
