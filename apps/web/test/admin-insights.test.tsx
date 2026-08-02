import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import {
  FunnelVisualisation,
  MartControls,
  RetentionHeatmap,
  SegmentationViewer
} from '@/components/admin-insights';

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

const SEGMENTATION = {
  dimension: 'state',
  total: 100,
  segments: [
    { key: 'kano', count: 40, percentage: 40 },
    { key: 'kaduna', count: 25, percentage: 25 }
  ]
};

const FUNNEL = [
  { key: 'registered', count: 100, conversionFromPrevious: null, conversionFromFirst: 1 },
  { key: 'profile_complete', count: 60, conversionFromPrevious: 0.6, conversionFromFirst: 0.6 },
  { key: 'first_course', count: 30, conversionFromPrevious: 0.5, conversionFromFirst: 0.3 },
  { key: 'first_application', count: 12, conversionFromPrevious: 0.4, conversionFromFirst: 0.12 }
];

const CHAPTER_FUNNEL = { events: 20, rsvps: 100, attendances: 70, rsvpPerEvent: 5, attendanceRate: 0.7 };

const RETENTION = {
  timezone: 'Africa/Lagos',
  currentWeek: '2026-03-02',
  maxWeeks: 12,
  rows: [
    { cohortWeek: '2026-02-16', size: 50, retention: [1, 0.5, null], retained: [50, 25, null] },
    { cohortWeek: '2026-02-23', size: 40, retention: [1, 0.75], retained: [40, 30] }
  ]
};

describe('Admin insights', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path.endsWith('/api/v1/analytics/segmentation')) {
        return jsonResponse({ data: { ...SEGMENTATION, dimension: parsed.searchParams.get('by') } });
      }
      if (path.endsWith('/api/v1/analytics/funnel/chapters')) {
        return jsonResponse({ data: CHAPTER_FUNNEL });
      }
      if (path.endsWith('/api/v1/analytics/funnel')) {
        return jsonResponse({ data: FUNNEL });
      }
      if (path.endsWith('/api/v1/analytics/retention')) {
        return jsonResponse({ data: RETENTION });
      }
      if (path.endsWith('/api/v1/analytics/marts/snapshot')) {
        return jsonResponse({ data: { memberKpis: {}, marketplace: {}, learning: {} } });
      }
      return jsonResponse({ data: null });
    });
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders segmentation counts and percentages for the selected dimension', async () => {
    renderWithProviders(<SegmentationViewer />);
    await waitFor(() => {
      expect(screen.getByText('kano')).toBeTruthy();
    });
    expect(screen.getByText('40.00%')).toBeTruthy();
    expect(screen.getByText(/members segmented by/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Segment by'), { target: { value: 'kyc_tier' } });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        new URL(String(url)).searchParams.get('by') === 'kyc_tier'
      );
      expect(call).toBeTruthy();
    });
  });

  it('renders member funnel stage bars with conversion percentages', async () => {
    renderWithProviders(<FunnelVisualisation />);
    await waitFor(() => {
      expect(screen.getByText('Registered')).toBeTruthy();
    });
    expect(screen.getByText('Profile complete')).toBeTruthy();
    expect(screen.getByText('First application')).toBeTruthy();
    // 60% conversion from previous step on profile_complete.
    expect(screen.getAllByText(/60\.0% from previous/).length).toBeGreaterThan(0);
  });

  it('renders the chapter funnel derived from events/rsvps/attendance', async () => {
    renderWithProviders(<FunnelVisualisation />);
    await waitFor(() => {
      expect(screen.getByText('Chapter funnel')).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText('Attendance')).toBeTruthy();
    });
  });

  it('switches the funnel trailing window', async () => {
    renderWithProviders(<FunnelVisualisation />);
    await waitFor(() => {
      expect(screen.getByText('Registered')).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText('Trailing window'), { target: { value: '30' } });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => {
        const parsed = new URL(String(url));
        return (
          parsed.pathname.endsWith('/api/v1/analytics/funnel') &&
          parsed.searchParams.get('windowDays') === '30'
        );
      });
      expect(call).toBeTruthy();
    });
  });

  it('renders the retention matrix with shaded cells and a partial-week marker', async () => {
    renderWithProviders(<RetentionHeatmap />);
    await waitFor(() => {
      expect(screen.getByText('2026-02-16')).toBeTruthy();
    });
    expect(screen.getByText('partial')).toBeTruthy();
    // 75% cell for the newer cohort, and a shaded background.
    const cell = screen.getByText('75.0%');
    expect(cell.style.background).toContain('rgba(60, 111, 77');
    // Unreached week renders a dash.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('runs a mart snapshot for the chosen date and confirms', async () => {
    renderWithProviders(<MartControls />);
    const dateInput = screen.getByLabelText('Snapshot date');
    fireEvent.change(dateInput, { target: { value: '2026-02-27' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run snapshot' }));
    await waitFor(() => {
      expect(screen.getByText(/Marts recomputed for/)).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find(([url, init]) => {
      const parsed = new URL(String(url));
      return (
        parsed.pathname.endsWith('/api/v1/analytics/marts/snapshot') &&
        (init as RequestInit)?.method === 'POST' &&
        parsed.searchParams.get('date') === '2026-02-27'
      );
    });
    expect(call).toBeTruthy();
  });

  it('offers a CSV export per mart', async () => {
    renderWithProviders(<MartControls />);
    expect(screen.getByText('Member KPIs')).toBeTruthy();
    expect(screen.getByText('Marketplace daily')).toBeTruthy();
    expect(screen.getByText('Learning daily')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Download CSV' })).toHaveLength(3);
  });
});
