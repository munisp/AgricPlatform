import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { latLngToCell } from 'h3-js';
import type { FarmPlot } from '@agric-platform/shared';
import { AppProvider } from '@/lib/app-state';
import { I18nProvider } from '@/lib/i18n';
import { clearApiCache } from '@/lib/api/hooks';
import type { CarbonPlot } from '@/lib/api/endpoints';
import {
  applyPortalFilters,
  canonicalStateName,
  carbonPlotToPortalPlot,
  farmPlotToPortalPlot,
  plotInBbox,
  plotsBbox,
  portalPlotsToFeatureCollection,
  stateForPoint
} from '@/components/geoportal/portal-plot';
import type { PortalPlot, StateBoundaryFeature } from '@/components/geoportal/portal-plot';
import { queryPlotIdsInBboxPure } from '@/components/geoportal/spatial-query';
import { PlotFilterBar } from '@/components/geoportal/plot-filters';
import { PlotDetailPanel } from '@/components/geoportal/plot-detail-panel';
import { GeoPortal } from '@/components/geoportal/geoportal';

expect.extend(toHaveNoViolations);

// The maplibre-gl map requires WebGL (absent in jsdom) and is dynamic-imported
// with ssr:false in the container; swap next/dynamic for a synchronous stub
// that exposes the props the container passes (plot count + onSelect).
vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function MockPlotMap(props: {
      plots: PortalPlot[];
      onSelect: (id: string | null) => void;
    }) {
      return (
        <div data-testid="mock-map" data-count={props.plots.length}>
          {props.plots.map((plot) => (
            <button key={plot.id} type="button" onClick={() => props.onSelect(plot.id)}>
              {`select-${plot.id}`}
            </button>
          ))}
        </div>
      );
    }
}));

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

function errorEnvelope(status: number, message: string) {
  return jsonResponse(
    {
      statusCode: status,
      error: 'Internal Server Error',
      message,
      path: '/api/v1',
      timestamp: new Date().toISOString()
    },
    status
  );
}

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <AppProvider>
      <I18nProvider>{ui}</I18nProvider>
    </AppProvider>
  );
}

/* ------------------------------------------------------------ fixtures */

// Lagos / Kano anchors; H3 indices computed with the same h3-js the API uses.
const LAGOS = { lat: 6.5244, long: 3.3792 };
const KANO = { lat: 12.0022, long: 8.592 };

const FARM_PLOT: FarmPlot = {
  id: 'plot-farm-1',
  ownerUserId: 'user-1',
  name: 'Kano maize field',
  state: 'Kano',
  lga: 'Kano Municipal',
  centroidLat: KANO.lat,
  centroidLong: KANO.long,
  boundaryGeojson: {
    type: 'Polygon',
    coordinates: [
      [
        [8.59, 12.0],
        [8.594, 12.0],
        [8.594, 12.004],
        [8.59, 12.004],
        [8.59, 12.0]
      ]
    ]
  },
  sizeHectares: 1.5,
  soilType: 'loamy',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1
};

const CARBON_PLOT: CarbonPlot = {
  id: 'plot-carbon-1',
  groupId: 'group-1',
  ownerUserId: 'user-2',
  name: 'Lagos agroforestry plot',
  practiceType: 'agroforestry',
  hectaresCenti: 250,
  centroidLat: LAGOS.lat,
  centroidLong: LAGOS.long,
  h3Res9: latLngToCell(LAGOS.lat, LAGOS.long, 9),
  status: 'ACTIVE',
  createdAt: '2026-01-02T00:00:00.000Z'
};

/** Tiny square "state" boundary around Lagos for point-in-polygon tagging. */
const LAGOS_STATE: StateBoundaryFeature = {
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [3.0, 6.2],
        [3.7, 6.2],
        [3.7, 6.9],
        [3.0, 6.9],
        [3.0, 6.2]
      ]
    ]
  },
  properties: { name: 'Lagos', iso: 'NG-LA' }
};

const STATES_FC = { type: 'FeatureCollection', features: [LAGOS_STATE] };

/* ------------------------------------------------------- pure helpers */

describe('geoportal portal-plot helpers', () => {
  it('maps farm plots with a valid walked boundary to polygon features', () => {
    const plot = farmPlotToPortalPlot(FARM_PLOT);
    expect(plot.geometryKind).toBe('polygon');
    expect(plot.feature.geometry.type).toBe('Polygon');
    expect(plot.state).toBe('Kano');
    expect(plot.hectares).toBe(1.5);
  });

  it('degrades farm plots without a boundary to centroid markers — never fabricates geometry', () => {
    const plot = farmPlotToPortalPlot({ ...FARM_PLOT, boundaryGeojson: undefined });
    expect(plot.geometryKind).toBe('centroid');
    expect(plot.feature.geometry.type).toBe('Point');
    expect(plot.feature.geometry).toEqual({
      type: 'Point',
      coordinates: [KANO.long, KANO.lat]
    });
    // Garbage geometry must not be trusted either.
    const junk = farmPlotToPortalPlot({ ...FARM_PLOT, boundaryGeojson: { type: 'LineString' } });
    expect(junk.geometryKind).toBe('centroid');
  });

  it('expands carbon plot H3 res-9 cells to closed polygons (client-side, like GET /geo/cells/:h3)', () => {
    const plot = carbonPlotToPortalPlot(CARBON_PLOT);
    expect(plot.geometryKind).toBe('polygon');
    expect(plot.feature.geometry.type).toBe('Polygon');
    const ring = (plot.feature.geometry as { coordinates: number[][][] }).coordinates[0]!;
    expect(ring.length).toBeGreaterThanOrEqual(7); // hexagon + closing vertex
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(plot.hectares).toBe(2.5); // hectaresCenti fixed-point → ha
    expect(plot.practiceType).toBe('agroforestry');
  });

  it('degrades malformed H3 indices to centroid markers', () => {
    const plot = carbonPlotToPortalPlot({ ...CARBON_PLOT, h3Res9: 'not-an-h3-index' });
    expect(plot.geometryKind).toBe('centroid');
  });

  it('normalises the pinned geoBoundaries FCT spelling to NIGERIAN_STATES', () => {
    expect(canonicalStateName('Abuja Federal Capital Territory')).toBe('FCT');
    expect(canonicalStateName(' Kano ')).toBe('Kano');
  });

  it('tags centroids with the containing state boundary (ray casting)', () => {
    expect(stateForPoint(LAGOS.long, LAGOS.lat, [LAGOS_STATE])).toBe('Lagos');
    expect(stateForPoint(KANO.long, KANO.lat, [LAGOS_STATE])).toBeUndefined();
  });

  it('filters by state and crop/practice over the unified list', () => {
    const farm = farmPlotToPortalPlot(FARM_PLOT);
    const carbon = { ...carbonPlotToPortalPlot(CARBON_PLOT), state: 'Lagos' };
    const all = [farm, carbon];
    expect(applyPortalFilters(all, {})).toHaveLength(2);
    expect(applyPortalFilters(all, { state: 'Kano' })).toEqual([farm]);
    expect(applyPortalFilters(all, { state: 'Lagos', practice: 'agroforestry' })).toEqual([
      carbon
    ]);
    expect(applyPortalFilters(all, { practice: 'woodlot' })).toHaveLength(0);
  });

  it('marks selection/highlight flags in the map FeatureCollection', () => {
    const plots = [farmPlotToPortalPlot(FARM_PLOT), carbonPlotToPortalPlot(CARBON_PLOT)];
    const fc = portalPlotsToFeatureCollection(plots, {
      highlightedIds: new Set(['plot-carbon-1']),
      selectedId: 'plot-farm-1'
    });
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]!.properties.selected).toBe(true);
    expect(fc.features[1]!.properties.highlighted).toBe(true);
  });

  it('bbox helpers: centroid-in-box mirrors the DuckDB SQL, outer bounds fit', () => {
    const plots = [farmPlotToPortalPlot(FARM_PLOT), carbonPlotToPortalPlot(CARBON_PLOT)];
    const lagosBox = { minLong: 3.0, minLat: 6.2, maxLong: 3.7, maxLat: 6.9 };
    expect(plotInBbox(plots[1]!, lagosBox)).toBe(true);
    expect(plotInBbox(plots[0]!, lagosBox)).toBe(false);
    expect(queryPlotIdsInBboxPure(plots, lagosBox)).toEqual(['plot-carbon-1']);
    // Largest first when several plots match.
    const allBox = { minLong: 0, minLat: 0, maxLong: 20, maxLat: 20 };
    expect(queryPlotIdsInBboxPure(plots, allBox)).toEqual(['plot-carbon-1', 'plot-farm-1']);
    expect(plotsBbox(plots)).toEqual({ minLong: 3.3792, minLat: 6.5244, maxLong: 8.592, maxLat: 12.0022 });
    expect(plotsBbox([])).toBeNull();
  });
});

/* ------------------------------------------------- DuckDB-WASM engine */

describe('geoportal spatial-query engine', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline')))
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails closed with a typed error when the WASM worker cannot be fetched', async () => {
    const { queryPlotIdsInBbox, resetSpatialEngine } = await import(
      '@/components/geoportal/spatial-query'
    );
    resetSpatialEngine();
    const plots = [farmPlotToPortalPlot(FARM_PLOT)];
    await expect(
      queryPlotIdsInBbox(plots, { minLong: 0, minLat: 0, maxLong: 20, maxLat: 20 })
    ).rejects.toThrow(/DuckDB/i);
  });

  it('rejects non-finite bounds before building SQL', async () => {
    const { queryPlotIdsInBbox, resetSpatialEngine } = await import(
      '@/components/geoportal/spatial-query'
    );
    resetSpatialEngine();
    await expect(
      queryPlotIdsInBbox([], { minLong: Number.NaN, minLat: 0, maxLong: 1, maxLat: 1 })
    ).rejects.toThrow(/finite/);
  });
});

/* ---------------------------------------------------------- filter bar */

describe('PlotFilterBar', () => {
  it('derives state/practice options from the plots and reports visible counts', () => {
    const plots = [
      farmPlotToPortalPlot(FARM_PLOT),
      { ...carbonPlotToPortalPlot(CARBON_PLOT), state: 'Lagos' }
    ];
    const onChange = vi.fn();
    renderWithProviders(<PlotFilterBar plots={plots} filters={{}} onChange={onChange} />);
    expect(screen.getByText('Showing 2 of 2 plots')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Kano' } });
    expect(onChange).toHaveBeenCalledWith({ state: 'Kano' });
    fireEvent.change(screen.getByLabelText('Crop / practice'), {
      target: { value: 'agroforestry' }
    });
    expect(onChange).toHaveBeenCalledWith({ practice: 'agroforestry' });
  });

  it('shows the filtered count when a filter is active', () => {
    const plots = [
      farmPlotToPortalPlot(FARM_PLOT),
      { ...carbonPlotToPortalPlot(CARBON_PLOT), state: 'Lagos' }
    ];
    renderWithProviders(
      <PlotFilterBar plots={plots} filters={{ state: 'Kano' }} onChange={() => {}} />
    );
    expect(screen.getByText('Showing 1 of 2 plots')).toBeTruthy();
  });
});

/* -------------------------------------------------------- detail panel */

describe('PlotDetailPanel', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string) => {
      const parsed = new URL(url, 'http://localhost:3000');
      if (parsed.pathname.endsWith('/vsla-carbon/plots/plot-carbon-1/estimates')) {
        return jsonResponse({
          data: [
            {
              id: 'est-1',
              plotId: 'plot-carbon-1',
              groupId: 'group-1',
              season: '2026-wet',
              coefficientVersion: 'v1',
              hectaresCenti: 250,
              practiceType: 'agroforestry',
              survivalRatePct: 82,
              seasonCount: 1,
              co2eMilliTonnes: 4250,
              basis: 'estimate',
              createdAt: '2026-02-01T00:00:00.000Z'
            }
          ]
        });
      }
      if (parsed.pathname.endsWith('/vsla-carbon/plots/plot-carbon-1/evidence')) {
        return jsonResponse({
          data: [
            {
              id: 'ev-1',
              plotId: 'plot-carbon-1',
              groupId: 'group-1',
              season: '2026-wet',
              submittedBy: 'user-2',
              submitterRole: 'enumerator',
              ndviHealthScore: 0.71,
              ndviClassification: 'healthy',
              ndviBasis: 'live',
              idempotencyKey: 'k1',
              createdAt: '2026-02-02T00:00:00.000Z'
            }
          ]
        });
      }
      if (parsed.pathname.endsWith('/farms/plots/plot-farm-1/plantings')) {
        return jsonResponse({
          data: [
            {
              id: 'pl-1',
              plotId: 'plot-farm-1',
              crop: 'Maize',
              season: '2026-wet',
              plantedAt: '2026-03-01T00:00:00.000Z',
              status: 'planted',
              createdAt: '2026-03-01T00:00:00.000Z',
              updatedAt: '2026-03-01T00:00:00.000Z',
              version: 1
            }
          ]
        });
      }
      return jsonResponse({ message: 'not found' }, 404);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('carbon plot: shows area, practice, carbon estimate (labelled) and NDVI evidence', async () => {
    renderWithProviders(
      <PlotDetailPanel plot={carbonPlotToPortalPlot(CARBON_PLOT)} onClose={() => {}} />
    );
    expect(screen.getByRole('heading', { name: 'Lagos agroforestry plot' })).toBeTruthy();
    expect(screen.getByText('2.50 ha')).toBeTruthy();
    expect(screen.getByText('agroforestry')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/4\.25 t CO₂e/)).toBeTruthy());
    expect(screen.getByText('estimate — not verification-grade')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/healthy/)).toBeTruthy());
    expect(screen.getByText(/health score 0\.71/)).toBeTruthy();
  });

  it('farm plot: shows state/LGA and current crops from plantings', async () => {
    renderWithProviders(
      <PlotDetailPanel plot={farmPlotToPortalPlot(FARM_PLOT)} onClose={() => {}} />
    );
    expect(screen.getByRole('heading', { name: 'Kano maize field' })).toBeTruthy();
    expect(screen.getByText('Kano · Kano Municipal')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Maize')).toBeTruthy());
  });

  it('fails closed with an error notice when the estimates call fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/estimates')) return errorEnvelope(500, 'db down');
      if (String(url).includes('/evidence')) return jsonResponse({ data: [] });
      return jsonResponse({ message: 'not found' }, 404);
    });
    renderWithProviders(
      <PlotDetailPanel plot={carbonPlotToPortalPlot(CARBON_PLOT)} onClose={() => {}} />
    );
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
  });

  it('has no accessibility violations', async () => {
    const { container } = renderWithProviders(
      <PlotDetailPanel plot={carbonPlotToPortalPlot(CARBON_PLOT)} onClose={() => {}} />
    );
    await waitFor(() => expect(screen.getByText(/4\.25 t CO₂e/)).toBeTruthy());
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

/* ------------------------------------------------- portal container */

describe('GeoPortal (/map)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearApiCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string) => {
      const parsed = new URL(String(url), 'http://localhost:3000');
      if (parsed.pathname === '/geo/nigeria-states.geojson') return jsonResponse(STATES_FC);
      if (parsed.pathname.endsWith('/api/v1/farms/plots')) {
        return jsonResponse({ data: [FARM_PLOT] });
      }
      if (parsed.pathname.endsWith('/api/v1/vsla-carbon/plots')) {
        return jsonResponse({ data: [CARBON_PLOT] });
      }
      if (parsed.pathname.endsWith('/api/v1/geo/boundaries')) {
        return jsonResponse({ data: [] });
      }
      if (parsed.pathname.endsWith('/api/v1/vsla-carbon/ndvi/status')) {
        return jsonResponse({ data: { configured: false, healthy: false, detail: 'stub' } });
      }
      return jsonResponse({ message: 'not found' }, 404);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders live farm + carbon plots, tags carbon state, filters, opens detail panel', async () => {
    renderWithProviders(<GeoPortal />);
    await waitFor(() => expect(screen.getByText('Showing 2 of 2 plots')).toBeTruthy());
    expect(screen.getByTestId('mock-map').getAttribute('data-count')).toBe('2');
    // NDVI provider badge (stub on this deployment).
    expect(screen.getByText(/NDVI status: satellite model not connected/)).toBeTruthy();
    // Carbon plot tagged 'Lagos' client-side via the pinned boundaries.
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Lagos' } });
    await waitFor(() => expect(screen.getByText('Showing 1 of 2 plots')).toBeTruthy());
    expect(screen.getByTestId('mock-map').getAttribute('data-count')).toBe('1');
    // Click-through to the detail panel (map onSelect callback).
    fireEvent.click(screen.getByRole('button', { name: 'select-plot-carbon-1' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Lagos agroforestry plot' })).toBeTruthy()
    );
  });

  it('fails closed with an error panel when the plot APIs are down — no fabricated geometry', async () => {
    fetchMock.mockImplementation((url: string) => {
      const parsed = new URL(String(url), 'http://localhost:3000');
      if (parsed.pathname === '/geo/nigeria-states.geojson') return jsonResponse(STATES_FC);
      if (parsed.pathname.endsWith('/api/v1/farms/plots')) return errorEnvelope(500, 'db down');
      if (parsed.pathname.endsWith('/api/v1/vsla-carbon/plots')) {
        return errorEnvelope(500, 'db down');
      }
      if (parsed.pathname.endsWith('/api/v1/vsla-carbon/ndvi/status')) {
        return errorEnvelope(500, 'db down');
      }
      return jsonResponse({ data: [] });
    });
    renderWithProviders(<GeoPortal />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByTestId('mock-map')).toBeNull();
  });
});
