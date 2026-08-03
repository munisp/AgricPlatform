'use client';

import { useMemo, useState } from 'react';
import { cellToBoundary, cellToLatLng } from 'h3-js';
import { H3_RESOLUTIONS, type GeoClustersResult, type H3Resolution } from '@agric-platform/shared';
import { useT } from '@/lib/i18n';
import { invalidateApiQueries, useApiMutation, useApiQuery } from '@/lib/api/hooks';
import { fetchGeoClusters, reindexGeo } from '@/lib/api/endpoints';
import { demoGeoClusters } from '@/lib/content';
import { ApiErrorNotice, OfflineDataNotice } from '@/components/api-state';
import { Card, EmptyState } from '@/components/ui';

/**
 * Admin farm-cluster map (Wave GEO).
 *
 * DELIBERATE CHOICE — SVG grid, NOT MapLibre GL: MapLibre needs WebGL,
 * which jsdom (our test environment) and many low-end field devices lack,
 * and it pulls runtime raster tiles from an external tile service. The SVG
 * fallback is deterministic (fixed viewBox + equirectangular projection),
 * fully unit-testable and offline-friendly. docs/geospatial.md documents
 * the MapLibre upgrade path (same /geo/farms/clusters + /geo/cells/:h3
 * endpoints feed a GeoJSON source).
 */

const VIEW_W = 640;
const VIEW_H = 420;
const PAD = 28;

interface ProjectedCell {
  cell: string;
  count: number;
  /** SVG polygon points "x,y x,y …". */
  points: string;
  /** Label anchor at the projected cell centre. */
  cx: number;
  cy: number;
}

/** Equirectangular fit of all cell vertices into the fixed viewBox. */
function projectCells(clusters: GeoClustersResult): ProjectedCell[] {
  const vertices = clusters.cells.flatMap(({ cell }) => cellToBoundary(cell, true));
  if (vertices.length === 0) {
    return [];
  }
  const longs = vertices.map(([long]) => long);
  const lats = vertices.map(([, lat]) => lat);
  const minLong = Math.min(...longs);
  const maxLong = Math.max(...longs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  // Guard degenerate spans (a single point would divide by zero).
  const spanLong = Math.max(maxLong - minLong, 1e-6);
  const spanLat = Math.max(maxLat - minLat, 1e-6);
  const project = (long: number, lat: number): [number, number] => [
    PAD + ((long - minLong) / spanLong) * (VIEW_W - 2 * PAD),
    VIEW_H - PAD - ((lat - minLat) / spanLat) * (VIEW_H - 2 * PAD)
  ];
  return clusters.cells.map(({ cell, count }) => {
    const points = cellToBoundary(cell, true)
      .map(([long, lat]) => project(long, lat).map((v) => v.toFixed(1)).join(','))
      .join(' ');
    const [lat, long] = cellToLatLng(cell);
    const [cx, cy] = project(long, lat);
    return { cell, count, points, cx, cy };
  });
}

/** Green ramp: light (few farms) → dark brand green (many). */
function fillFor(count: number, max: number): string {
  const t = max <= 1 ? 1 : count / max;
  const lightness = 88 - Math.round(52 * t); // 88% → 36%
  return `hsl(142 45% ${lightness}%)`;
}

export function GeoClusterMap() {
  const { t } = useT();
  const [resolution, setResolution] = useState<H3Resolution>(5);
  const query = useApiQuery<GeoClustersResult>(
    `geo.clusters.${resolution}`,
    () => fetchGeoClusters(resolution).then((res) => res.data),
    { fallbackData: demoGeoClusters }
  );
  const reindex = useApiMutation<void, { indexed: number }>({
    mutationFn: async () => {
      const { data } = await reindexGeo();
      return { indexed: data.reports.reduce((sum, report) => sum + report.indexed, 0) };
    },
    onSuccess: () => {
      invalidateApiQueries(...H3_RESOLUTIONS.map((res) => `geo.clusters.${res}`));
      query.refresh();
    }
  });

  const clusters = query.data;
  const cells = useMemo(() => (clusters ? projectCells(clusters) : []), [clusters]);
  const maxCount = cells.reduce((max, cell) => Math.max(max, cell.count), 1);

  if (!clusters) {
    return query.error ? <ApiErrorNotice error={query.error} onRetry={query.refresh} /> : null;
  }

  return (
    <Card title={t('geo.mapTitle')}>
      <div className="row" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <label className="small muted">
          {t('geo.resolution')}{' '}
          <select
            aria-label={t('geo.resolution')}
            value={resolution}
            onChange={(event) => setResolution(Number(event.target.value) as H3Resolution)}
          >
            {H3_RESOLUTIONS.map((res) => (
              <option key={res} value={res}>
                {res}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={reindex.status === 'pending'}
          onClick={() => void reindex.mutate(undefined)}
        >
          {reindex.status === 'pending' ? t('geo.reindexing') : t('geo.reindex')}
        </button>
      </div>
      {query.source === 'fallback' ? (
        <OfflineDataNotice>{t('geo.offlineNotice')}</OfflineDataNotice>
      ) : null}
      {reindex.status === 'success' && reindex.data ? (
        <p role="status" className="small">
          {t('geo.reindexDone', { indexed: reindex.data.indexed })}
        </p>
      ) : null}
      <p className="small muted">{t('geo.totalLabel', { total: clusters.total })}</p>
      {cells.length === 0 ? (
        <EmptyState title={t('geo.empty')} />
      ) : (
        <>
          <svg
            role="img"
            aria-label={t('geo.mapTitle')}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            className="geo-cluster-map"
            width="100%"
          >
            {cells.map((cell) => (
              <g key={cell.cell} data-cell={cell.cell} data-count={cell.count}>
                <polygon
                  points={cell.points}
                  fill={fillFor(cell.count, maxCount)}
                  stroke="hsl(142 30% 25%)"
                  strokeWidth={1}
                >
                  <title>{`${cell.cell}: ${t('geo.cellCount', { count: cell.count })}`}</title>
                </polygon>
                <text
                  x={cell.cx.toFixed(1)}
                  y={cell.cy.toFixed(1)}
                  textAnchor="middle"
                  fontSize={12}
                  fill={cell.count / maxCount > 0.5 ? '#fff' : 'hsl(142 30% 20%)'}
                >
                  {cell.count}
                </text>
              </g>
            ))}
          </svg>
          <p className="small muted">{t('geo.legend')}</p>
        </>
      )}
    </Card>
  );
}
