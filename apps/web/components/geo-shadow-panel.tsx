'use client';

import { useState } from 'react';
import type { GeoCreditBasisFlags, GeoCreditShadowScore } from '@agric-platform/shared';
import { useApiQuery } from '@/lib/api/hooks';
import { ApiError } from '@/lib/api/errors';
import { fetchGeoCreditShadow, recomputeGeoCreditShadow } from '@/lib/api/endpoints';
import { useT } from '@/lib/i18n';
import { StatusBadge } from '@/components/ui';

/**
 * Geo verification (shadow) panel — credit-officer view of the deterministic
 * sixth credit factor. SHADOW MODE: this panel is read-only evidence; the
 * score is never used in approve/decline decisions. Basis badges (STUB /
 * LIVE / UNAVAILABLE) are always visible so officers can never mistake
 * simulated fixtures for live model inference.
 */

function BasisBadge({ label, basis }: { label: string; basis: GeoCreditBasisFlags['crop'] }) {
  const { t } = useT();
  const tone = basis === 'live' ? 'success' : basis === 'stub' ? 'warning' : 'critical';
  const text =
    basis === 'live'
      ? t('credit.geoShadowBasisLive')
      : basis === 'stub'
        ? t('credit.geoShadowBasisStub')
        : t('credit.geoShadowBasisUnavailable');
  return (
    <StatusBadge tone={tone} ariaLabel={`${label}: ${text}`}>
      {label}: {text}
    </StatusBadge>
  );
}

function ShadowBody({ shadow }: { shadow: GeoCreditShadowScore }) {
  const { t } = useT();
  const rows: Array<[string, number]> = [
    [t('credit.geoShadowPlot'), shadow.breakdown.plotVerification],
    [t('credit.geoShadowArea'), shadow.breakdown.areaPlausibility],
    [t('credit.geoShadowFlood'), shadow.breakdown.floodRisk],
    [t('credit.geoShadowCrop'), shadow.breakdown.cropHealth],
    [t('credit.geoShadowFreshness'), shadow.breakdown.dataFreshness]
  ];
  return (
    <div className="stack" data-testid="geo-shadow-body">
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 700 }}>{t('credit.geoShadowScore')}</span>
        <span style={{ fontWeight: 700 }} aria-label={`Geo factor score ${shadow.factorScore ?? 0} of 100`}>
          {shadow.factorScore === null
            ? t('credit.geoShadowBasisUnavailable')
            : t('credit.geoShadowOutOf', { score: shadow.factorScore })}
        </span>
      </div>
      <ul className="stack" aria-label="Geo factor breakdown">
        {rows.map(([label, value]) => (
          <li key={label} className="cluster" style={{ justifyContent: 'space-between' }}>
            <span className="small">{label}</span>
            <span className="small" style={{ fontWeight: 700 }}>
              {value}
            </span>
          </li>
        ))}
      </ul>
      <div className="cluster">
        <BasisBadge label={t('credit.geoShadowBasisFlood')} basis={shadow.basis.flood} />
        <BasisBadge label={t('credit.geoShadowBasisCrop')} basis={shadow.basis.crop} />
      </div>
      <p className="small muted">
        {t('credit.geoShadowComputedAt', {
          timestamp: new Date(shadow.computedAt).toLocaleString('en-NG')
        })}
      </p>
    </div>
  );
}

export function GeoShadowPanel({ applicationId }: { applicationId: string }) {
  const { t } = useT();
  const query = useApiQuery(`credit:geo-shadow:${applicationId}`, () =>
    fetchGeoCreditShadow(applicationId).then((res) => res.data)
  );

  const error = query.error;
  const statusCode = error instanceof ApiError ? error.statusCode : undefined;

  return (
    <section className="stack" aria-label={t('credit.geoShadowTitle')}>
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <strong className="small">{t('credit.geoShadowTitle')}</strong>
        <StatusBadge tone="info">{t('credit.geoShadowBanner')}</StatusBadge>
      </div>
      {query.isLoading ? <p className="small muted">…</p> : null}
      {query.data ? <ShadowBody shadow={query.data} /> : null}
      {!query.isLoading && !query.data && statusCode === 503 ? (
        <p className="small" role="alert">
          {t('credit.geoShadowUnavailable')}
        </p>
      ) : null}
      {!query.isLoading && !query.data && statusCode === 404 ? (
        <p className="small muted">{t('credit.geoShadowDisabled')}</p>
      ) : null}
      {!query.isLoading && !query.data && statusCode !== 503 && statusCode !== 404 && error ? (
        <p className="small muted">{t('credit.geoShadowEmpty')}</p>
      ) : null}
    </section>
  );
}

/** Admin batch recompute trigger with an honest result summary. */
export function GeoShadowRecomputeButton({ onDone }: { onDone?: () => void }) {
  const { t } = useT();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function run() {
    setPending(true);
    setNotice(null);
    setFailed(false);
    try {
      const res = await recomputeGeoCreditShadow();
      setNotice(
        t('credit.geoShadowRecomputeDone', {
          recomputed: res.data.recomputed,
          skipped: res.data.skipped,
          unavailable: res.data.unavailable
        })
      );
      onDone?.();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="cluster">
      <button type="button" className="button" disabled={pending} onClick={() => void run()}>
        {pending ? t('credit.geoShadowRecomputing') : t('credit.geoShadowRecompute')}
      </button>
      {notice ? (
        <span className="small" role="status">
          {notice}
        </span>
      ) : null}
      {failed ? (
        <span className="small" role="alert">
          {t('credit.geoShadowRecomputeFailed')}
        </span>
      ) : null}
    </div>
  );
}
