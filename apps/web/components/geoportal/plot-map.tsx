'use client';

import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { isValidBoundaryGeojson } from '@agric-platform/shared';
import type { GeoBoundary } from '@agric-platform/shared';
import type { Bbox, PortalPlot, StateBoundaryFeature } from './portal-plot';
import { plotsBbox, portalPlotsToFeatureCollection } from './portal-plot';

/**
 * GeoPortal MapLibre view — GeoLibre (github.com/opengeos/GeoLibre)
 * component stack: MapLibre GL map with GeoJSON sources/layers synced from
 * React props. Loaded via next/dynamic with ssr:false (WebGL is
 * client-only); the parent owns all data fetching and state.
 *
 * Layers (bottom → top):
 *  1. Basemap — raster tiles from NEXT_PUBLIC_MAP_TILES (OSM default; no
 *     API keys are ever hardcoded).
 *  2. State boundaries — pinned public GeoJSON (public/geo/nigeria-states.geojson).
 *  3. API boundaries — admin-registered LGA/ward/custom boundaries
 *     (GET /geo/boundaries), drawn only when the API returns real geometry.
 *  4. Plot boundaries — farm boundaryGeojson polygons + carbon H3 cells;
 *     plots without a boundary render as centroid markers (never fabricated).
 *  5. Query box — the drawn bbox used by the DuckDB-WASM spatial query.
 */

/** Nigeria-wide fallback view when no plots are loaded yet. */
const NIGERIA_BOUNDS: [[number, number], [number, number]] = [
  [2.69, 4.24],
  [14.68, 13.9]
];

const PLOTS_SOURCE = 'geoportal-plots';
const STATES_SOURCE = 'geoportal-states';
const API_BOUNDARIES_SOURCE = 'geoportal-api-boundaries';
const DRAW_SOURCE = 'geoportal-draw';

export function resolveTileUrl(): string {
  return (
    process.env.NEXT_PUBLIC_MAP_TILES ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
  );
}

function baseStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: [resolveTileUrl()],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors'
      }
    },
    layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }]
  };
}

/** API boundaries (any kind) → outline FeatureCollection; invalid geometry is dropped. */
function boundariesToFeatureCollection(boundaries: GeoBoundary[]) {
  return {
    type: 'FeatureCollection' as const,
    features: boundaries
      .filter((boundary) => isValidBoundaryGeojson(boundary.boundaryGeojson))
      .map((boundary) => ({
        type: 'Feature' as const,
        geometry: boundary.boundaryGeojson as StateBoundaryFeature['geometry'],
        properties: { id: boundary.id, kind: boundary.kind, name: boundary.name }
      }))
  };
}

export interface PlotMapProps {
  /** Filtered plots to render. */
  plots: PortalPlot[];
  /** Pinned state-boundary polygons (already fetched by the container). */
  states: StateBoundaryFeature[];
  /** Admin-registered boundaries from GET /geo/boundaries (may be empty). */
  apiBoundaries: GeoBoundary[];
  selectedId?: string;
  onSelect: (id: string | null) => void;
  /** Ids matched by the latest DuckDB-WASM spatial query (null = no query). */
  highlightIds: ReadonlySet<string> | null;
  /** When true, the next two map clicks define the spatial-query bbox. */
  drawMode: boolean;
  onBboxDrawn: (bbox: Bbox) => void;
  /** Report init/WebGL failures so the container can fail closed. */
  onInitError: (error: unknown) => void;
}

export function PlotMap({
  plots,
  states,
  apiBoundaries,
  selectedId,
  onSelect,
  highlightIds,
  drawMode,
  onBboxDrawn,
  onInitError
}: PlotMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const drawCornerRef = useRef<[number, number] | null>(null);
  // Refs keep event handlers (registered once at map init) pointed at the
  // latest props without re-binding map listeners on every render.
  const propsRef = useRef({ plots, selectedId, highlightIds, drawMode });
  propsRef.current = { plots, selectedId, highlightIds, drawMode };
  const callbacksRef = useRef({ onSelect, onBboxDrawn, onInitError });
  callbacksRef.current = { onSelect, onBboxDrawn, onInitError };
  const statesRef = useRef(states);
  statesRef.current = states;
  const apiBoundariesRef = useRef(apiBoundaries);
  apiBoundariesRef.current = apiBoundaries;

  /* ------------------------------------------------ map init (once) */
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: baseStyle(),
        bounds: NIGERIA_BOUNDS,
        fitBoundsOptions: { padding: 24 },
        attributionControl: { compact: true }
      });
    } catch (error) {
      // WebGL unavailable / style invalid — fail closed, parent shows notice.
      callbacksRef.current.onInitError(error);
      return;
    }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), 'bottom-left');

    map.on('load', () => {
      map.addSource(STATES_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      map.addSource(API_BOUNDARIES_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      map.addSource(PLOTS_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        promoteId: 'id'
      });
      map.addSource(DRAW_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      map.addLayer({
        id: 'states-fill',
        type: 'fill',
        source: STATES_SOURCE,
        paint: { 'fill-color': '#2d6a4f', 'fill-opacity': 0.05 }
      });
      map.addLayer({
        id: 'states-line',
        type: 'line',
        source: STATES_SOURCE,
        paint: { 'line-color': '#2d6a4f', 'line-width': 1, 'line-opacity': 0.5 }
      });
      map.addLayer({
        id: 'api-boundaries-line',
        type: 'line',
        source: API_BOUNDARIES_SOURCE,
        paint: { 'line-color': '#6b531f', 'line-width': 1, 'line-dasharray': [3, 2] }
      });
      map.addLayer({
        id: 'plots-fill',
        type: 'fill',
        source: PLOTS_SOURCE,
        filter: ['==', ['get', 'geometryKind'], 'polygon'],
        paint: {
          'fill-color': [
            'case',
            ['==', ['get', 'highlighted'], true],
            '#e76f51',
            ['==', ['get', 'source'], 'carbon'],
            '#2d9d78',
            '#52b788'
          ],
          'fill-opacity': ['case', ['==', ['get', 'highlighted'], true], 0.55, 0.3]
        }
      });
      map.addLayer({
        id: 'plots-line',
        type: 'line',
        source: PLOTS_SOURCE,
        filter: ['==', ['get', 'geometryKind'], 'polygon'],
        paint: {
          'line-color': [
            'case',
            ['==', ['get', 'highlighted'], true],
            '#c1440e',
            ['==', ['get', 'source'], 'carbon'],
            '#1b6e52',
            '#2d6a4f'
          ],
          'line-width': [
            'case',
            ['==', ['get', 'selected'], true],
            3,
            ['==', ['get', 'highlighted'], true],
            2.5,
            1.2
          ]
        }
      });
      map.addLayer({
        id: 'plots-points',
        type: 'circle',
        source: PLOTS_SOURCE,
        filter: ['==', ['get', 'geometryKind'], 'centroid'],
        paint: {
          'circle-radius': [
            'case',
            ['==', ['get', 'selected'], true],
            9,
            ['==', ['get', 'highlighted'], true],
            8,
            5
          ],
          'circle-color': [
            'case',
            ['==', ['get', 'highlighted'], true],
            '#e76f51',
            ['==', ['get', 'source'], 'carbon'],
            '#2d9d78',
            '#52b788'
          ],
          'circle-stroke-color': '#1b4332',
          'circle-stroke-width': 1
        }
      });
      map.addLayer({
        id: 'draw-line',
        type: 'line',
        source: DRAW_SOURCE,
        paint: { 'line-color': '#c1440e', 'line-width': 2, 'line-dasharray': [2, 2] }
      });

      // Initial paint with whatever props were current when the style loaded.
      syncSources(map, propsRef.current, statesRef.current, apiBoundariesRef.current);
      fitToPlots(map, propsRef.current.plots);
    });

    const clickable = ['plots-fill', 'plots-points'];
    map.on('click', (event) => {
      if (propsRef.current.drawMode) {
        handleDrawClick(map, event.lngLat);
        return;
      }
      const hit = map.queryRenderedFeatures(event.point, { layers: clickable })[0];
      callbacksRef.current.onSelect(hit ? String(hit.properties?.id) : null);
    });
    map.on('mousemove', (event) => {
      if (propsRef.current.drawMode && drawCornerRef.current) {
        updateDrawBox(map, drawCornerRef.current, [event.lngLat.lng, event.lngLat.lat]);
        return;
      }
      const hit = map.queryRenderedFeatures(event.point, { layers: clickable })[0];
      map.getCanvas().style.cursor = hit ? 'pointer' : '';
    });

    function handleDrawClick(m: maplibregl.Map, lngLat: maplibregl.LngLat) {
      if (!drawCornerRef.current) {
        drawCornerRef.current = [lngLat.lng, lngLat.lat];
        return;
      }
      const [ax, ay] = drawCornerRef.current;
      drawCornerRef.current = null;
      callbacksRef.current.onBboxDrawn({
        minLong: Math.min(ax, lngLat.lng),
        minLat: Math.min(ay, lngLat.lat),
        maxLong: Math.max(ax, lngLat.lng),
        maxLat: Math.max(ay, lngLat.lat)
      });
    }

    return () => {
      mapRef.current = null;
      map.remove();
    };
     
  }, []);

  /* ----------------------------------- prop → source synchronisation */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    syncSources(map, { plots, selectedId, highlightIds }, states, apiBoundaries);
    fitToPlots(map, plots);
  }, [plots, selectedId, highlightIds, drawMode, states, apiBoundaries]);

  // Clear the drawn box when leaving draw mode without finishing.
  useEffect(() => {
    if (!drawMode) {
      drawCornerRef.current = null;
    }
  }, [drawMode]);

  return (
    <div
      ref={containerRef}
      className="geoportal-map"
      data-testid="geoportal-map"
      aria-label="Farm plot map"
    />
  );
}

/* ------------------------------------------------------------------ */
/* Map instance helpers (outside React — operate on the live map).     */
/* ------------------------------------------------------------------ */

function setSourceData(map: maplibregl.Map, id: string, data: unknown) {
  const source = map.getSource<maplibregl.GeoJSONSource>(id);
  if (source) source.setData(data as never);
}

function syncSources(
  map: maplibregl.Map,
  props: {
    plots: PortalPlot[];
    selectedId?: string;
    highlightIds: ReadonlySet<string> | null;
  },
  states: StateBoundaryFeature[],
  apiBoundaries: GeoBoundary[]
) {
  if (!map.isStyleLoaded()) return;
  setSourceData(map, STATES_SOURCE, { type: 'FeatureCollection', features: states });
  setSourceData(map, API_BOUNDARIES_SOURCE, boundariesToFeatureCollection(apiBoundaries));
  setSourceData(
    map,
    PLOTS_SOURCE,
    portalPlotsToFeatureCollection(props.plots, {
      highlightedIds: props.highlightIds ?? undefined,
      selectedId: props.selectedId
    })
  );
}

function fitToPlots(map: maplibregl.Map, plots: PortalPlot[]) {
  const bbox = plotsBbox(plots);
  if (!bbox) return;
  if (bbox.minLong === bbox.maxLong && bbox.minLat === bbox.maxLat) {
    map.jumpTo({ center: [bbox.minLong, bbox.minLat], zoom: 12 });
    return;
  }
  map.fitBounds(
    [
      [bbox.minLong, bbox.minLat],
      [bbox.maxLong, bbox.maxLat]
    ],
    { padding: 48, maxZoom: 12, duration: 0 }
  );
}

function updateDrawBox(
  map: maplibregl.Map,
  cornerA: [number, number],
  cornerB: [number, number]
) {
  const [minLong, maxLong] = [Math.min(cornerA[0], cornerB[0]), Math.max(cornerA[0], cornerB[0])];
  const [minLat, maxLat] = [Math.min(cornerA[1], cornerB[1]), Math.max(cornerA[1], cornerB[1])];
  const ring: [number, number][] = [
    [minLong, minLat],
    [maxLong, minLat],
    [maxLong, maxLat],
    [minLong, maxLat],
    [minLong, minLat]
  ];
  setSourceData(map, DRAW_SOURCE, {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} }
    ]
  });
}
