'use client';

import { useCallback, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useT } from '@/lib/i18n';
import { useApiQuery } from '@/lib/api/hooks';
import {
  fetchCarbonNdviStatus,
  fetchCarbonPlots,
  listFarmPlots,
  listGeoBoundaries
} from '@/lib/api/endpoints';
import { ApiErrorNotice, SkeletonBlock } from '@/components/api-state';
import { Card, EmptyState } from '@/components/ui';
import type { Bbox, PortalFilters, PortalPlot, StateBoundaryFeature } from './portal-plot';
import {
  applyPortalFilters,
  carbonPlotToPortalPlot,
  farmPlotToPortalPlot,
  stateForPoint
} from './portal-plot';
import { PlotFilterBar } from './plot-filters';
import { PlotDetailPanel } from './plot-detail-panel';
import {
  SpatialEngineError,
  queryPlotIdsInBbox,
  queryPlotIdsInBboxPure
} from './spatial-query';

/**
 * GeoPortal — the farm-plot map portal (route: /map).
 *
 * Design + component base: GeoLibre (github.com/opengeos/GeoLibre), the
 * client-side GIS stack (React + MapLibre GL + DuckDB-WASM). GeoLibre ships
 * as an app; its published @geolibre/* npm packages are not consumable here
 * (@geolibre/map vendors a second React copy and pulls Cesium/geotiff —
 * see docs/geospatial.md), so this portal re-implements the same stack and
 * conventions against the platform API. Code lives in
 * components/geoportal/ so the upstream GeoLibre container deployment and
 * this portal share structure.
 *
 * Data (all live, no fixtures — fail closed when the API is down):
 *  - farm plots    GET /farms/plots          (walked boundaryGeojson)
 *  - carbon plots  GET /vsla-carbon/plots    (H3 res-9 cells → polygons)
 *  - boundaries    GET /geo/boundaries       (admin-registered LGA/ward)
 *  - states        /geo/nigeria-states.geojson (pinned public geoBoundaries)
 *  - NDVI status   GET /vsla-carbon/ndvi/status
 */

// WebGL is client-only: the map chunk (maplibre-gl) never ships in the
// initial bundle and never renders on the server.
const PlotMap = dynamic(
  () => import('./plot-map').then((mod) => mod.PlotMap),
  { ssr: false, loading: () => <SkeletonBlock lines={6} /> }
);

/** Pinned state-boundary GeoJSON (provenance in the file's metadata block). */
const STATES_URL = '/geo/nigeria-states.geojson';

async function fetchPinnedStates(): Promise<StateBoundaryFeature[]> {
  const response = await fetch(STATES_URL, { headers: { Accept: 'application/geo+json' } });
  if (!response.ok) {
    throw new Error(`Pinned state boundaries unavailable (${response.status})`);
  }
  const body = (await response.json()) as { features?: StateBoundaryFeature[] };
  return Array.isArray(body.features) ? body.features : [];
}

/** Spatial-query panel: draw a bbox on the map → DuckDB-WASM SQL selection. */
function SpatialQueryControls({
  plots,
  bbox,
  drawMode,
  onToggleDraw,
  highlights,
  onHighlights
}: {
  plots: PortalPlot[];
  /** The box drawn on the map (null until the user finishes drawing). */
  bbox: Bbox | null;
  drawMode: boolean;
  onToggleDraw: () => void;
  highlights: string[] | null;
  onHighlights: (ids: string[] | null) => void;
}) {
  const { t } = useT();
  const [status, setStatus] = useState<'idle' | 'running'>('idle');
  const [error, setError] = useState<unknown>(undefined);
  const [engine, setEngine] = useState<'duckdb' | 'builtin'>('duckdb');

  const runQuery = useCallback(
    async (useBuiltin: boolean) => {
      if (!bbox) return;
      setStatus('running');
      setError(undefined);
      try {
        const ids = useBuiltin
          ? queryPlotIdsInBboxPure(plots, bbox)
          : await queryPlotIdsInBbox(plots, bbox);
        setEngine(useBuiltin ? 'builtin' : 'duckdb');
        onHighlights(ids);
      } catch (err) {
        // Fail closed: honest engine error, no fabricated results.
        setError(err instanceof SpatialEngineError ? err : new SpatialEngineError('failed', err));
        onHighlights(null);
      } finally {
        setStatus('idle');
      }
    },
    [bbox, plots, onHighlights]
  );

  return (
    <div className="geoportal-spatial">
      <div className="row" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          aria-pressed={drawMode}
          onClick={onToggleDraw}
        >
          {drawMode ? t('geoportal.spatial.cancelDraw') : t('geoportal.spatial.drawBox')}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={!bbox || status === 'running'}
          onClick={() => void runQuery(false)}
        >
          {status === 'running' ? t('geoportal.spatial.running') : t('geoportal.spatial.run')}
        </button>
        {highlights ? (
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => onHighlights(null)}
          >
            {t('geoportal.spatial.clear')}
          </button>
        ) : null}
      </div>
      <p className="small muted">
        {drawMode
          ? t('geoportal.spatial.drawHintActive')
          : bbox
            ? t('geoportal.spatial.boxReady')
            : t('geoportal.spatial.drawHint')}
      </p>
      {error ? (
        <div role="alert">
          <ApiErrorNotice error={error} onRetry={() => void runQuery(false)} />
          <p style={{ marginTop: '0.5rem' }}>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => {
                setError(undefined);
                void runQuery(true);
              }}
            >
              {t('geoportal.spatial.useBuiltin')}
            </button>
          </p>
        </div>
      ) : null}
      {highlights ? (
        <p className="small" role="status">
          {t('geoportal.spatial.results', { count: highlights.length })}
          {engine === 'builtin' ? (
            <span className="muted"> {t('geoportal.spatial.builtinNote')}</span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

export function GeoPortal() {
  const { t } = useT();
  const [filters, setFilters] = useState<PortalFilters>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [queryBox, setQueryBox] = useState<Bbox | null>(null);
  const [highlights, setHighlights] = useState<string[] | null>(null);
  const [mapError, setMapError] = useState<unknown>(undefined);

  const farmQuery = useApiQuery('geoportal.farmPlots', () =>
    listFarmPlots().then((res) => res.data)
  );
  const carbonQuery = useApiQuery('geoportal.carbonPlots', () =>
    fetchCarbonPlots().then((res) => res.data)
  );
  const boundariesQuery = useApiQuery('geoportal.boundaries', () =>
    listGeoBoundaries().then((res) => res.data)
  );
  const statesQuery = useApiQuery('geoportal.pinnedStates', fetchPinnedStates);
  const ndviQuery = useApiQuery('geoportal.ndviStatus', () =>
    fetchCarbonNdviStatus().then((res) => res.data)
  );

  const states = useMemo(() => statesQuery.data ?? [], [statesQuery.data]);

  // Unified plot list; carbon plots are tagged with a state client-side via
  // point-in-polygon over the pinned boundaries so the state filter covers
  // both sources.
  const plots = useMemo<PortalPlot[]>(() => {
    const farm = (farmQuery.data ?? []).map(farmPlotToPortalPlot);
    const carbon = (carbonQuery.data ?? []).map((plot) => {
      const portalPlot = carbonPlotToPortalPlot(plot);
      const state = stateForPoint(portalPlot.centroidLong, portalPlot.centroidLat, states);
      return state ? { ...portalPlot, state } : portalPlot;
    });
    return [...farm, ...carbon];
  }, [farmQuery.data, carbonQuery.data, states]);

  const filtered = useMemo(() => applyPortalFilters(plots, filters), [plots, filters]);
  const selected = selectedId ? (plots.find((plot) => plot.id === selectedId) ?? null) : null;
  const highlightSet = useMemo(() => (highlights ? new Set(highlights) : null), [highlights]);

  const onBboxDrawn = useCallback((bbox: Bbox) => {
    setDrawMode(false);
    setQueryBox(bbox);
    setHighlights(null); // a new box invalidates the previous selection
  }, []);

  const onHighlights = useCallback((ids: string[] | null) => {
    setHighlights(ids);
  }, []);

  const firstLoad =
    farmQuery.isLoading && carbonQuery.isLoading && !farmQuery.error && !carbonQuery.error;
  const bothFailed = farmQuery.error !== undefined && carbonQuery.error !== undefined;

  if (firstLoad) return <SkeletonBlock lines={6} />;
  if (bothFailed) {
    // Fail closed: the portal never fabricates geometry from fixtures.
    return (
      <Card title={t('geoportal.mapTitle')}>
        <ApiErrorNotice
          error={farmQuery.error}
          onRetry={() => {
            farmQuery.refresh();
            carbonQuery.refresh();
            boundariesQuery.refresh();
          }}
        />
      </Card>
    );
  }

  const partialError =
    farmQuery.error !== undefined && carbonQuery.error === undefined
      ? { label: t('geoportal.sourceFarm'), error: farmQuery.error, retry: farmQuery.refresh }
      : carbonQuery.error !== undefined && farmQuery.error === undefined
        ? {
            label: t('geoportal.sourceCarbon'),
            error: carbonQuery.error,
            retry: carbonQuery.refresh
          }
        : null;

  return (
    <div className="geoportal">
      <Card title={t('geoportal.mapTitle')}>
        {partialError ? (
          <p className="notice notice-info" role="status">
            {t('geoportal.partialError', { source: partialError.label })}{' '}
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={partialError.retry}
            >
              {t('apiState.tryAgain')}
            </button>
          </p>
        ) : null}
        {ndviQuery.data ? (
          <p className="small muted">
            {ndviQuery.data.configured && ndviQuery.data.healthy
              ? t('geoportal.ndvi.live')
              : t('geoportal.ndvi.stub')}
          </p>
        ) : null}
        <PlotFilterBar plots={plots} filters={filters} onChange={setFilters} />
        {mapError ? (
          <div className="empty" role="alert">
            <p style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
              {t('geoportal.mapErrorTitle')}
            </p>
            <p className="small">{t('geoportal.mapErrorHint')}</p>
          </div>
        ) : (
          <PlotMap
            plots={filtered}
            states={states}
            apiBoundaries={boundariesQuery.data ?? []}
            selectedId={selectedId ?? undefined}
            onSelect={(id) => setSelectedId(id)}
            highlightIds={highlightSet}
            drawMode={drawMode}
            onBboxDrawn={onBboxDrawn}
            onInitError={setMapError}
          />
        )}
        {plots.length === 0 ? (
          <EmptyState title={t('geoportal.empty')} hint={t('geoportal.emptyHint')} />
        ) : null}
        <SpatialQueryControls
          plots={filtered}
          bbox={queryBox}
          drawMode={drawMode}
          onToggleDraw={() => setDrawMode((value) => !value)}
          highlights={highlights}
          onHighlights={onHighlights}
        />
      </Card>
      {selected ? (
        <PlotDetailPanel plot={selected} onClose={() => setSelectedId(null)} />
      ) : null}
    </div>
  );
}
