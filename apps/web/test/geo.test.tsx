import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { GeoClusterMap } from '@/components/geo-cluster-map';

expect.extend(toHaveNoViolations);

// jsdom does no layout and the stylesheet is not loaded — color contrast is
// covered by test/contrast.test.ts against the CSS source.
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

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

// Real res-5 H3 cells (h3-js 4.5.0) for the two demo plot locations.
const CLUSTERS = {
  entity: 'farm_plot',
  resolution: 5,
  cells: [
    { cell: '85581b97fffffff', count: 3 },
    { cell: '8558182ffffffff', count: 1 }
  ],
  total: 4
};

const CLUSTERS_RES7 = {
  entity: 'farm_plot',
  resolution: 7,
  cells: [{ cell: '87581b966ffffff', count: 2 }],
  total: 2
};

const REINDEX = {
  reports: [
    { entity: 'farm_plot', scanned: 4, indexed: 4, skipped: 0 },
    { entity: 'profile', scanned: 9, indexed: 7, skipped: 2 }
  ]
};

describe('GeoClusterMap (admin /admin/geo)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      const method = init?.method ?? 'GET';
      if (parsed.pathname.endsWith('/api/v1/geo/reindex') && method === 'POST') {
        return jsonResponse({ data: REINDEX });
      }
      if (parsed.pathname.endsWith('/api/v1/geo/farms/clusters')) {
        return jsonResponse({
          data: parsed.searchParams.get('res') === '7' ? CLUSTERS_RES7 : CLUSTERS
        });
      }
      return jsonResponse({ message: 'not found' }, 404);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders each cluster cell as a labelled SVG polygon', async () => {
    renderWithProviders(<GeoClusterMap />);
    await waitFor(() => expect(screen.getByText('4 farms indexed')).toBeTruthy());
    const groups = document.querySelectorAll('g[data-cell]');
    expect(groups).toHaveLength(2);
    expect(document.querySelector('g[data-cell="85581b97fffffff"]')?.getAttribute('data-count'))
      .toBe('3');
    // Count labels inside the cells.
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    // Deterministic SVG projection.
    const polygon = document.querySelector('polygon');
    expect(polygon?.getAttribute('points')).toMatch(/^\d+(\.\d)?,\d+(\.\d)? /);
  });

  it('switches resolution and refetches clusters for it', async () => {
    renderWithProviders(<GeoClusterMap />);
    await waitFor(() => expect(screen.getByText('4 farms indexed')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Grid size (H3 resolution)'), {
      target: { value: '7' }
    });
    await waitFor(() => expect(screen.getByText('2 farms indexed')).toBeTruthy());
    const groups = document.querySelectorAll('g[data-cell]');
    expect(groups).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('res=7'))
    ).toBe(true);
  });

  it('rebuilds the index from the button and reports indexed counts', async () => {
    renderWithProviders(<GeoClusterMap />);
    await waitFor(() => expect(screen.getByText('4 farms indexed')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild the index' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('11 records updated')
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).includes('/api/v1/geo/reindex') && (init?.method ?? 'GET') === 'POST'
      )
    ).toBe(true);
  });

  it('has no accessibility violations', async () => {
    const { container } = renderWithProviders(<GeoClusterMap />);
    await waitFor(() => expect(screen.getByText('4 farms indexed')).toBeTruthy());
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
