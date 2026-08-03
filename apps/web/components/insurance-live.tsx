'use client';

import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  FloodSeverityRank,
  ParametricPolicy,
  ParametricProduct,
  ParametricTriggerEvent
} from '@agric-platform/shared';
import { invalidateApiQueries, useApiQuery } from '@/lib/api/hooks';
import {
  fetchInsuranceProducts,
  fetchMyInsurancePolicies,
  fetchMyInsurancePayouts,
  fetchMyInsuranceTriggerEvents,
  issueInsurancePolicy,
  listFarmPlots,
  quoteParametricPolicy
} from '@/lib/api/endpoints';
import { useT } from '@/lib/i18n';
import { Card, EmptyState, StatusBadge, formatKobo, type Tone } from '@/components/ui';

/**
 * Parametric insurance rail (wave-insurance) — farmer-facing live sections.
 * Basis badges (STUB / LIVE / UNAVAILABLE) are always visible on trigger
 * evidence, and payout rows carry the execution:'stub' label so simulated
 * rails can never be mistaken for real cover or real money.
 */

/** Client-side mirror of the server rate card (apps/api …/premium.ts). */
const FLOOD_MODIFIER_BPS: Record<FloodSeverityRank, number> = {
  none: 10_000,
  low: 10_500,
  moderate: 11_250,
  high: 12_500,
  severe: 15_000
};

export function previewPremiumKobo(
  sumInsuredKobo: number,
  premiumRateBps: number,
  floodBand: FloodSeverityRank
): number {
  const numerator = sumInsuredKobo * premiumRateBps * FLOOD_MODIFIER_BPS[floodBand];
  return Math.floor((2 * numerator + 100_000_000) / 200_000_000);
}

function policyStatusTone(status: ParametricPolicy['status']): Tone {
  switch (status) {
    case 'active':
      return 'success';
    case 'paid':
      return 'success';
    case 'triggered':
    case 'payout_proposed':
      return 'warning';
    case 'expired':
      return 'critical';
    default:
      return 'neutral';
  }
}

function usePolicyStatusLabel() {
  const { t } = useT();
  return (status: ParametricPolicy['status']): string => {
    switch (status) {
      case 'quoted':
        return t('insurance.statusQuoted');
      case 'active':
        return t('insurance.statusActive');
      case 'triggered':
        return t('insurance.statusTriggered');
      case 'payout_proposed':
        return t('insurance.statusPayoutProposed');
      case 'paid':
        return t('insurance.statusPaid');
      case 'expired':
        return t('insurance.statusExpired');
    }
  };
}

function BasisBadge({ label, basis }: { label: string; basis: 'stub' | 'live' | 'unavailable' }) {
  const { t } = useT();
  const tone: Tone = basis === 'live' ? 'success' : basis === 'stub' ? 'warning' : 'critical';
  const text =
    basis === 'live'
      ? t('insurance.basisLive')
      : basis === 'stub'
        ? t('insurance.basisStub')
        : t('insurance.basisUnavailable');
  return (
    <StatusBadge tone={tone} ariaLabel={`${label}: ${text}`}>
      {label}: {text}
    </StatusBadge>
  );
}

function triggerSummary(product: ParametricProduct): string {
  const { trigger } = product;
  const direction = trigger.operator === 'lte' ? '≤' : '≥';
  const unit =
    trigger.metric === 'rainfall_mm' ? 'mm' : trigger.metric === 'heat_days' ? 'days' : 'rank';
  return `${trigger.metric} ${direction} ${trigger.threshold} ${unit} over ${trigger.observationWindowDays}d (h3 res ${trigger.h3Resolution})`;
}

export function InsuranceCatalogSection() {
  const { t } = useT();
  const query = useApiQuery('insurance:products', () =>
    fetchInsuranceProducts().then((res) => res.data)
  );
  return (
    <div className="stack" data-testid="insurance-catalog">
      {query.isLoading ? <p className="small muted">…</p> : null}
      {!query.isLoading && query.error ? (
        <p className="small" role="alert">
          {t('insurance.catalogError')}
        </p>
      ) : null}
      {!query.isLoading && !query.error && query.data && query.data.length === 0 ? (
        <EmptyState title={t('insurance.catalogEmpty')} />
      ) : null}
      <div className="grid">
        {(query.data ?? []).map((product) => (
          <Card key={product.code}>
            <div className="stack">
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <strong>{product.name}</strong>
                <StatusBadge tone="info">{product.peril}</StatusBadge>
              </div>
              <p className="small muted">{product.description}</p>
              <p className="small">
                <strong>{t('insurance.triggerLabel')}:</strong> {triggerSummary(product)}
              </p>
              <p className="small">
                <strong>{t('insurance.seasonLabel')}:</strong> {product.trigger.season} ·{' '}
                <strong>{t('insurance.premiumRateLabel')}:</strong> {product.premiumRateBps / 100}%
              </p>
              <p className="small">
                <strong>{t('insurance.payoutBandsLabel')}:</strong>{' '}
                {[...product.payoutTable]
                  .sort((a, b) => b.minRatio - a.minRatio)
                  .map((band) => `${band.payoutPercent}%`)
                  .join(' / ')}
              </p>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function InsuranceQuoteSection() {
  const { t } = useT();
  const products = useApiQuery('insurance:products', () =>
    fetchInsuranceProducts().then((res) => res.data)
  );
  const plots = useApiQuery('insurance:plots', () => listFarmPlots().then((res) => res.data));
  const [productCode, setProductCode] = useState('');
  const [plotId, setPlotId] = useState('');
  const [sumInsuredNaira, setSumInsuredNaira] = useState('10000');
  const [floodBand, setFloodBand] = useState<FloodSeverityRank>('none');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [serverQuote, setServerQuote] = useState<{
    premiumKobo: number;
    pricingBasis: 'stub' | 'live';
    policyId: string;
    issued: boolean;
  } | null>(null);

  const product = (products.data ?? []).find((item) => item.code === productCode);
  const sumInsuredKobo = Math.round(Number(sumInsuredNaira || '0') * 100);
  const previewKobo =
    product && Number.isSafeInteger(sumInsuredKobo) && sumInsuredKobo > 0
      ? previewPremiumKobo(sumInsuredKobo, product.premiumRateBps, floodBand)
      : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!product || !plotId) return;
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const res = await quoteParametricPolicy({
        productCode: product.code,
        plotId,
        season: product.trigger.season,
        sumInsuredKobo
      });
      setServerQuote({
        premiumKobo: res.data.quote.premiumKobo,
        pricingBasis: res.data.quote.pricingBasis,
        policyId: res.data.policy.id,
        issued: false
      });
      setNotice(t('insurance.quoteSuccess'));
      invalidateApiQueries('insurance:policies');
    } catch {
      setError(t('insurance.quoteError'));
    } finally {
      setWorking(false);
    }
  }

  async function issue() {
    if (!serverQuote) return;
    setWorking(true);
    setError(null);
    try {
      await issueInsurancePolicy(serverQuote.policyId);
      setServerQuote({ ...serverQuote, issued: true });
      setNotice(t('insurance.issueSuccess'));
      invalidateApiQueries('insurance:policies');
    } catch {
      setError(t('insurance.issueError'));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="stack" data-testid="insurance-quote">
      <form className="stack" onSubmit={submit} aria-label={t('insurance.quoteTitle')}>
        <label className="stack" htmlFor="ins-product">
          <span className="small">{t('insurance.quoteProduct')}</span>
          <select
            id="ins-product"
            value={productCode}
            onChange={(event) => setProductCode(event.target.value)}
            required
          >
            <option value="">—</option>
            {(products.data ?? []).map((item) => (
              <option key={item.code} value={item.code}>
                {item.name} ({item.trigger.season})
              </option>
            ))}
          </select>
        </label>
        <label className="stack" htmlFor="ins-plot">
          <span className="small">{t('insurance.quotePlot')}</span>
          <select
            id="ins-plot"
            value={plotId}
            onChange={(event) => setPlotId(event.target.value)}
            required
          >
            <option value="">—</option>
            {(plots.data ?? []).map((plot) => (
              <option key={plot.id} value={plot.id}>
                {plot.name} — {plot.lga}, {plot.state}
              </option>
            ))}
          </select>
        </label>
        <label className="stack" htmlFor="ins-sum">
          <span className="small">{t('insurance.quoteSumInsured')}</span>
          <input
            id="ins-sum"
            inputMode="numeric"
            value={sumInsuredNaira}
            onChange={(event) => setSumInsuredNaira(event.target.value)}
            required
          />
        </label>
        <label className="stack" htmlFor="ins-band">
          <span className="small">{t('insurance.quoteFloodBand')}</span>
          <select
            id="ins-band"
            value={floodBand}
            onChange={(event) => setFloodBand(event.target.value as FloodSeverityRank)}
          >
            {(['none', 'low', 'moderate', 'high', 'severe'] as const).map((band) => (
              <option key={band} value={band}>
                {band}
              </option>
            ))}
          </select>
        </label>
        {previewKobo !== null ? (
          <p className="small" data-testid="insurance-quote-preview">
            <strong>{t('insurance.quotePreview')}:</strong> {formatKobo(previewKobo)}
          </p>
        ) : null}
        <div>
          <button type="submit" disabled={working || !product || !plotId || previewKobo === null}>
            {working ? t('insurance.quoteWorking') : t('insurance.quoteSubmit')}
          </button>
        </div>
      </form>
      {error ? (
        <p className="small" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="small muted">{notice}</p> : null}
      {serverQuote ? (
        <Card>
          <div className="stack" data-testid="insurance-server-quote">
            <strong className="small">{t('insurance.quoteResultTitle')}</strong>
            <p className="small">
              {t('insurance.quotePremium')}: <strong>{formatKobo(serverQuote.premiumKobo)}</strong>
            </p>
            <BasisBadge label={t('insurance.quoteBasis')} basis={serverQuote.pricingBasis} />
            {!serverQuote.issued ? (
              <div>
                <button type="button" onClick={issue} disabled={working}>
                  {working ? t('insurance.issueWorking') : t('insurance.issueAction')}
                </button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

export function MyInsurancePoliciesSection() {
  const { t } = useT();
  const statusLabel = usePolicyStatusLabel();
  const query = useApiQuery('insurance:policies', () =>
    fetchMyInsurancePolicies().then((res) => res.data)
  );
  return (
    <div className="stack" data-testid="insurance-policies">
      {query.isLoading ? <p className="small muted">…</p> : null}
      {!query.isLoading && query.error ? (
        <p className="small" role="alert">
          {t('insurance.policiesError')}
        </p>
      ) : null}
      {!query.isLoading && !query.error && query.data && query.data.length === 0 ? (
        <EmptyState title={t('insurance.policiesEmpty')} />
      ) : null}
      <ul className="stack" aria-label={t('insurance.policiesTitle')}>
        {(query.data ?? []).map((policy) => (
          <li key={policy.id} className="cluster" style={{ justifyContent: 'space-between' }}>
            <span className="small">
              <strong>{policy.productCode}</strong> · {policy.season} ·{' '}
              {t('insurance.policySumInsured')} {formatKobo(policy.sumInsuredKobo)} ·{' '}
              {t('insurance.policyPremium')} {formatKobo(policy.premiumKobo)}
            </span>
            <StatusBadge tone={policyStatusTone(policy.status)}>
              {statusLabel(policy.status)}
            </StatusBadge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TriggerEventCard({ event }: { event: ParametricTriggerEvent }) {
  const { t } = useT();
  const { evidence } = event;
  return (
    <Card>
      <div className="stack" data-testid="insurance-trigger-event">
        <div className="cluster" style={{ justifyContent: 'space-between' }}>
          <strong className="small">{evidence.metric}</strong>
          <StatusBadge tone="warning">
            {t('insurance.percentOfSumInsured', { percent: event.payoutPercent })}
          </StatusBadge>
        </div>
        <p className="small">
          {t('insurance.evidenceObserved')}: <strong>{evidence.observedValue}</strong> ·{' '}
          {t('insurance.evidenceThreshold')}: {evidence.operator === 'lte' ? '≤' : '≥'}{' '}
          {evidence.threshold} · {t('insurance.evidenceMargin')}:{' '}
          {(evidence.breachRatio * 100).toFixed(1)}%
        </p>
        <p className="small muted">
          {t('insurance.evidenceCell')}: {evidence.h3Cell} · {evidence.season} ·{' '}
          {formatKobo(event.payoutKobo)}
        </p>
        <div className="cluster">
          {evidence.basis.weather !== 'unavailable' ? (
            <BasisBadge label={t('insurance.basisWeather')} basis={evidence.basis.weather} />
          ) : null}
          {evidence.basis.flood !== 'unavailable' ? (
            <BasisBadge label={t('insurance.basisFlood')} basis={evidence.basis.flood} />
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export function InsuranceTriggerMonitorSection() {
  const { t } = useT();
  const query = useApiQuery('insurance:trigger-events', () =>
    fetchMyInsuranceTriggerEvents().then((res) => res.data)
  );
  return (
    <div className="stack" data-testid="insurance-trigger-monitor">
      {query.isLoading ? <p className="small muted">…</p> : null}
      {!query.isLoading && query.error ? (
        <p className="small" role="alert">
          {t('insurance.monitorError')}
        </p>
      ) : null}
      {!query.isLoading && !query.error && query.data && query.data.length === 0 ? (
        <EmptyState title={t('insurance.monitorEmpty')} />
      ) : null}
      {(query.data ?? []).map((event) => (
        <TriggerEventCard key={event.id} event={event} />
      ))}
    </div>
  );
}

export function InsurancePayoutLedgerSection() {
  const { t } = useT();
  const statusLabel = useMemo(
    () => ({ proposed: t('insurance.statusPayoutProposed'), paid: t('insurance.statusPaid') }),
    [t]
  );
  const query = useApiQuery('insurance:payouts', () =>
    fetchMyInsurancePayouts().then((res) => res.data)
  );
  return (
    <div className="stack" data-testid="insurance-payout-ledger">
      <p className="small muted">{t('insurance.stubNotice')}</p>
      {query.isLoading ? <p className="small muted">…</p> : null}
      {!query.isLoading && query.error ? (
        <p className="small" role="alert">
          {t('insurance.payoutError')}
        </p>
      ) : null}
      {!query.isLoading && !query.error && query.data && query.data.length === 0 ? (
        <EmptyState title={t('insurance.payoutEmpty')} />
      ) : null}
      {query.data && query.data.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">{t('insurance.payoutPolicy')}</th>
              <th scope="col">{t('insurance.payoutAmount')}</th>
              <th scope="col">{t('insurance.payoutStatus')}</th>
              <th scope="col">{t('insurance.payoutExecution')}</th>
              <th scope="col">{t('insurance.payoutDate')}</th>
            </tr>
          </thead>
          <tbody>
            {query.data.map((payout) => (
              <tr key={payout.id}>
                <td className="small">{payout.policyId}</td>
                <td className="small">{formatKobo(payout.amountKobo)}</td>
                <td>
                  <StatusBadge tone={payout.status === 'paid' ? 'success' : 'warning'}>
                    {statusLabel[payout.status]}
                  </StatusBadge>
                </td>
                <td>
                  <StatusBadge tone="warning" ariaLabel={t('insurance.payoutExecutionStub')}>
                    {payout.execution}
                  </StatusBadge>
                </td>
                <td className="small">
                  {new Date(payout.paidAt ?? payout.proposedAt).toLocaleDateString('en-NG')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
