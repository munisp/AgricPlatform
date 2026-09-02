'use client';

import { useT } from '@/lib/i18n';
import { useApiQuery } from '@/lib/api/hooks';
import {
  fetchCarbonEstimates,
  fetchCarbonEvidence,
  listCropPlantings
} from '@/lib/api/endpoints';
import type { PortalPlot } from './portal-plot';
import { ApiErrorNotice, SkeletonBlock } from '@/components/api-state';

/**
 * GeoPortal plot detail panel (GeoLibre-style inspect panel): opens when a
 * plot is clicked on the map. Carbon plots lazily load their MRV estimates
 * (always labelled "estimate — not verification-grade", matching the API
 * contract) and latest NDVI-linked evidence; farm plots lazily load current
 * plantings so the panel can show actual crops.
 */

function latestByCreatedAt<T extends { createdAt: string }>(rows: T[]): T | undefined {
  return rows.reduce<T | undefined>(
    (latest, row) => (!latest || row.createdAt > latest.createdAt ? row : latest),
    undefined
  );
}

/** Latest persisted carbon estimate, formatted from fixed-point milli-tonnes. */
function CarbonEstimateSection({ plotId }: { plotId: string }) {
  const { t } = useT();
  const query = useApiQuery(`geoportal.estimates.${plotId}`, () =>
    fetchCarbonEstimates(plotId).then((res) => res.data)
  );
  if (query.isLoading) return <SkeletonBlock lines={1} />;
  if (query.error && !query.data) {
    return <ApiErrorNotice error={query.error} onRetry={query.refresh} />;
  }
  const latest = query.data ? latestByCreatedAt(query.data) : undefined;
  if (!latest) return <p className="small muted">{t('geoportal.detail.noEstimate')}</p>;
  const tonnes = latest.co2eMilliTonnes / 1000;
  return (
    <dl className="geoportal-facts">
      <dt>{t('geoportal.detail.carbonEstimate')}</dt>
      <dd>
        {t('geoportal.detail.carbonEstimateValue', {
          tonnes: tonnes.toFixed(2),
          season: latest.season
        })}
      </dd>
      <dd>
        <span className="badge badge-warning">{t('geoportal.detail.estimateBasis')}</span>
      </dd>
    </dl>
  );
}

/** Latest NDVI-linked evidence for a carbon plot (score + classification). */
function CarbonNdviSection({ plotId }: { plotId: string }) {
  const { t } = useT();
  const query = useApiQuery(`geoportal.evidence.${plotId}`, () =>
    fetchCarbonEvidence(plotId).then((res) => res.data)
  );
  if (query.isLoading) return <SkeletonBlock lines={1} />;
  if (query.error && !query.data) {
    return <ApiErrorNotice error={query.error} onRetry={query.refresh} />;
  }
  const withNdvi = (query.data ?? []).filter((row) => row.ndviClassification !== undefined);
  const latest = latestByCreatedAt(withNdvi);
  if (!latest) return <p className="small muted">{t('geoportal.detail.noNdvi')}</p>;
  return (
    <dl className="geoportal-facts">
      <dt>{t('geoportal.detail.ndviStatus')}</dt>
      <dd>
        {latest.ndviClassification}
        {latest.ndviHealthScore !== undefined
          ? ` · ${t('geoportal.detail.ndviScore', { score: latest.ndviHealthScore.toFixed(2) })}`
          : ''}
      </dd>
      <dd className="small muted">
        {latest.ndviBasis === 'live'
          ? t('geoportal.detail.ndviLive')
          : t('geoportal.detail.ndviStub')}
      </dd>
    </dl>
  );
}

/** Current crops for a farm plot (from its plantings). */
function FarmCropsSection({ plotId }: { plotId: string }) {
  const { t } = useT();
  const query = useApiQuery(`geoportal.plantings.${plotId}`, () =>
    listCropPlantings(plotId).then((res) => res.data)
  );
  if (query.isLoading) return <SkeletonBlock lines={1} />;
  if (query.error && !query.data) {
    return <ApiErrorNotice error={query.error} onRetry={query.refresh} />;
  }
  const crops = [...new Set((query.data ?? []).map((row) => row.crop))];
  if (crops.length === 0) return <p className="small muted">{t('geoportal.detail.noCrops')}</p>;
  return (
    <dl className="geoportal-facts">
      <dt>{t('geoportal.detail.crops')}</dt>
      <dd>{crops.join(', ')}</dd>
    </dl>
  );
}

export function PlotDetailPanel({
  plot,
  onClose
}: {
  plot: PortalPlot;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <aside className="geoportal-detail" aria-label={t('geoportal.detail.title')}>
      <div className="geoportal-detail-head">
        <h3>{plot.name}</h3>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={onClose}
          aria-label={t('geoportal.detail.close')}
        >
          ×
        </button>
      </div>
      <p className="small muted">
        {plot.source === 'farm' ? t('geoportal.sourceFarm') : t('geoportal.sourceCarbon')}
        {' · '}
        {plot.geometryKind === 'polygon'
          ? t('geoportal.detail.boundaryPolygon')
          : t('geoportal.detail.boundaryCentroid')}
      </p>
      <dl className="geoportal-facts">
        <dt>{t('geoportal.detail.plotId')}</dt>
        <dd>{plot.id}</dd>
        <dt>{t('geoportal.detail.area')}</dt>
        <dd>{t('geoportal.detail.areaValue', { hectares: plot.hectares.toFixed(2) })}</dd>
        {plot.state ? (
          <>
            <dt>{t('geoportal.detail.state')}</dt>
            <dd>
              {plot.state}
              {plot.lga ? ` · ${plot.lga}` : ''}
            </dd>
          </>
        ) : null}
        {plot.practiceType ? (
          <>
            <dt>{t('geoportal.detail.practice')}</dt>
            <dd>{plot.practiceType}</dd>
          </>
        ) : null}
        {plot.status ? (
          <>
            <dt>{t('geoportal.detail.status')}</dt>
            <dd>{plot.status}</dd>
          </>
        ) : null}
        {plot.h3Res9 ? (
          <>
            <dt>{t('geoportal.detail.h3')}</dt>
            <dd>
              <code>{plot.h3Res9}</code>
            </dd>
          </>
        ) : null}
      </dl>
      {plot.source === 'carbon' ? (
        <>
          <CarbonEstimateSection plotId={plot.id} />
          <CarbonNdviSection plotId={plot.id} />
        </>
      ) : (
        <FarmCropsSection plotId={plot.id} />
      )}
    </aside>
  );
}
