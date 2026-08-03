import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import { FarmsHub, PlotForm } from '@/components/farms-live';

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

const PLOT = {
  id: 'plot-1',
  ownerUserId: 'user-adamu',
  name: 'Zaria North Plot',
  state: 'Kaduna',
  lga: 'Zaria',
  centroidLat: 11.0855,
  centroidLong: 7.7199,
  sizeHectares: 2.5,
  soilType: 'loamy',
  createdAt: '2026-04-12T08:00:00.000Z',
  updatedAt: '2026-07-18T09:30:00.000Z',
  version: 3
};

const PLANTING = {
  id: 'planting-1',
  plotId: 'plot-1',
  crop: 'Maize',
  variety: 'Oba Super 2',
  season: '2026-wet',
  plantedAt: '2026-05-15T00:00:00.000Z',
  expectedHarvestAt: '2026-09-15T00:00:00.000Z',
  status: 'growing',
  createdAt: '2026-05-15T08:00:00.000Z',
  updatedAt: '2026-05-15T08:00:00.000Z',
  version: 1
};

const EXPENSE = {
  id: 'expense-1',
  plotId: 'plot-1',
  category: 'fertilizer',
  amountKobo: 750000,
  incurredAt: '2026-06-01T00:00:00.000Z',
  note: 'NPK 20-10-10, 5 bags',
  createdAt: '2026-06-01T09:00:00.000Z'
};

const SUMMARY = {
  ownerUserId: 'user-adamu',
  plotCount: 1,
  totalHectares: 2.5,
  activePlantings: 1,
  harvestByCrop: [{ crop: 'Maize', totalQuantity: 42, harvestCount: 1 }],
  totalExpensesKobo: 750000
};

function router(url: string, init?: RequestInit) {
  const path = new URL(url).pathname;
  const method = init?.method ?? 'GET';
  if (path.endsWith('/api/v1/farms/summary')) return jsonResponse({ data: SUMMARY });
  if (path.endsWith('/api/v1/farms/plots') && method === 'POST') {
    const body = JSON.parse(String(init?.body));
    return jsonResponse({ data: { ...PLOT, id: 'plot-new', ...body, version: 1 } });
  }
  if (path.endsWith('/api/v1/farms/plots')) return jsonResponse({ data: [PLOT] });
  if (path.endsWith('/api/v1/farms/plots/plot-1/plantings')) return jsonResponse({ data: [PLANTING] });
  if (path.endsWith('/api/v1/farms/plots/plot-1/expenses')) return jsonResponse({ data: [EXPENSE] });
  if (path.endsWith('/api/v1/farms/plantings/planting-1/harvests')) return jsonResponse({ data: [] });
  return jsonResponse({ message: 'not found' }, 404);
}

describe('FarmsHub', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(router);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders summary cards and the plot list from the API', async () => {
    renderWithProviders(<FarmsHub />);
    await waitFor(() => expect(screen.getByText('Zaria North Plot')).toBeTruthy());
    expect(screen.getByText('Your farm at a glance')).toBeTruthy();
    expect(screen.getByText('Maize: 42 (1)')).toBeTruthy();
    const summaryCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/api/v1/farms/summary')
    );
    expect(summaryCall).toBeTruthy();
  });

  it('shows the offline fallback notice when the API is unreachable', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    renderWithProviders(<FarmsHub />);
    await waitFor(() =>
      expect(screen.getAllByText(/showing reference data/i).length).toBeGreaterThan(0)
    );
    // Demo fallback plots render instead of an error wall.
    expect(screen.getByText('Zaria North Plot')).toBeTruthy();
  });

  it('creates a plot through the form and posts to /farms/plots', async () => {
    renderWithProviders(<FarmsHub />);
    await waitFor(() => expect(screen.getByText('Zaria North Plot')).toBeTruthy());
    fireEvent.click(screen.getByText('Register plot'));
    fireEvent.change(screen.getByLabelText('Plot name'), { target: { value: 'Kano River Plot' } });
    fireEvent.change(screen.getByLabelText('LGA'), { target: { value: 'Kura' } });
    fireEvent.change(screen.getByLabelText('Centre latitude'), { target: { value: '11.7' } });
    fireEvent.change(screen.getByLabelText('Centre longitude'), { target: { value: '8.4' } });
    fireEvent.change(screen.getByLabelText('Size (hectares)'), { target: { value: '4' } });
    fireEvent.click(screen.getByText('Save plot'));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith('/api/v1/farms/plots') && (init?.method ?? 'GET') === 'POST'
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post![1]?.body));
      expect(body.name).toBe('Kano River Plot');
      expect(body.state).toBe('Kaduna');
      expect(body.sizeHectares).toBe(4);
    });
  });

  it('opens plot detail tabs with plantings and expenses', async () => {
    renderWithProviders(<FarmsHub />);
    await waitFor(() => expect(screen.getByText('Zaria North Plot')).toBeTruthy());
    fireEvent.click(screen.getByText('Plot'));
    await waitFor(() => expect(screen.getByText(/Oba Super 2/)).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Expenses' }));
    await waitFor(() => expect(screen.getByText(/NPK 20-10-10/)).toBeTruthy());
  });

  it('has no accessibility violations', async () => {
    const { container } = renderWithProviders(<FarmsHub />);
    await waitFor(() => expect(screen.getByText('Zaria North Plot')).toBeTruthy());
    const results = await axe(container, AXE_OPTIONS);
    expect(results).toHaveNoViolations();
  });
});

describe('PlotForm boundary validation', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(router);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('rejects invalid GeoJSON boundaries before any POST', async () => {
    renderWithProviders(<PlotForm onSaved={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('Plot name'), { target: { value: 'Bad Boundary' } });
    fireEvent.change(screen.getByLabelText('LGA'), { target: { value: 'Zaria' } });
    fireEvent.change(screen.getByLabelText('Centre latitude'), { target: { value: '11' } });
    fireEvent.change(screen.getByLabelText('Centre longitude'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Size (hectares)'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Boundary (GeoJSON)'), {
      target: { value: '{"type":"Point","coordinates":[7,11]}' }
    });
    fireEvent.click(screen.getByText('Save plot'));
    await waitFor(() =>
      expect(screen.getByText(/must be a GeoJSON Polygon or MultiPolygon/)).toBeTruthy()
    );
    const post = fetchMock.mock.calls.find(([, init]) => (init?.method ?? 'GET') === 'POST');
    expect(post).toBeUndefined();
  });

  it('accepts a valid Polygon boundary', async () => {
    const onSaved = vi.fn();
    renderWithProviders(<PlotForm onSaved={onSaved} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('Plot name'), { target: { value: 'Good Boundary' } });
    fireEvent.change(screen.getByLabelText('LGA'), { target: { value: 'Zaria' } });
    fireEvent.change(screen.getByLabelText('Centre latitude'), { target: { value: '11' } });
    fireEvent.change(screen.getByLabelText('Centre longitude'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Size (hectares)'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Boundary (GeoJSON)'), {
      target: {
        value: '{"type":"Polygon","coordinates":[[[7,11],[7.1,11],[7.1,11.1],[7,11]]]}'
      }
    });
    fireEvent.click(screen.getByText('Save plot'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(([, init]) => (init?.method ?? 'GET') === 'POST');
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post![1]?.body)).boundaryGeojson.type).toBe('Polygon');
  });
});
