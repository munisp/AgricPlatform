'use client';

import { useT } from '@/lib/i18n';
import type { PortalFilters, PortalPlot } from './portal-plot';
import { applyPortalFilters, distinctSorted } from './portal-plot';

/**
 * GeoPortal filter bar (GeoLibre-style layer/query panel): filter the
 * plotted farm + carbon plots by state and by crop/practice. Controlled
 * component — state lives in the portal container so the map, the result
 * count and the spatial-query results always agree.
 */

export function PlotFilterBar({
  plots,
  filters,
  onChange
}: {
  /** Unfiltered plot list — options and counts are derived from it. */
  plots: PortalPlot[];
  filters: PortalFilters;
  onChange: (next: PortalFilters) => void;
}) {
  const { t } = useT();
  const states = distinctSorted(plots.map((plot) => plot.state));
  const practices = distinctSorted(plots.map((plot) => plot.practiceType));
  const visible = applyPortalFilters(plots, filters);

  return (
    <div className="geoportal-filters" role="group" aria-label={t('geoportal.filters.title')}>
      <label className="small muted">
        {t('geoportal.filters.state')}{' '}
        <select
          aria-label={t('geoportal.filters.state')}
          value={filters.state ?? ''}
          onChange={(event) =>
            onChange({ ...filters, state: event.target.value || undefined })
          }
        >
          <option value="">{t('geoportal.filters.allStates')}</option>
          {states.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
      </label>
      <label className="small muted">
        {t('geoportal.filters.practice')}{' '}
        <select
          aria-label={t('geoportal.filters.practice')}
          value={filters.practice ?? ''}
          onChange={(event) =>
            onChange({ ...filters, practice: event.target.value || undefined })
          }
        >
          <option value="">{t('geoportal.filters.allPractices')}</option>
          {practices.map((practice) => (
            <option key={practice} value={practice}>
              {practice}
            </option>
          ))}
        </select>
      </label>
      <p className="small muted" role="status" aria-live="polite">
        {t('geoportal.filters.results', { shown: visible.length, total: plots.length })}
      </p>
    </div>
  );
}
