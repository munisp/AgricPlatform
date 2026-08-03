'use client';

import { fetchFloodRisk, fetchFloodRiskStatus } from '@/lib/api/endpoints';
import { useApiQuery } from '@/lib/api/hooks';
import { useT } from '@/lib/i18n';
import { Card, StatusBadge } from '@/components/ui';
import { QueryState } from '@/components/api-state';

function severityTone(severity: string) {
  if (severity === 'severe' || severity === 'high') return 'critical' as const;
  if (severity === 'moderate' || severity === 'low') return 'warning' as const;
  return 'info' as const;
}

/**
 * Flood-risk card (wave ML). Honest states:
 * - stub driver  → demo fixture, clearly badged "demo data";
 * - http driver unreachable/misconfigured → "not set up" empty state;
 * - live sidecar → model estimate, still badged as an unverified estimate
 *   with the NiMet caveat. Never presented as satellite-verified fact.
 */
export function FloodRiskCard() {
  const { t } = useT();

  const status = useApiQuery('geo-intel:flood-risk:status', () =>
    fetchFloodRiskStatus().then((res) => res.data)
  );

  // Only fetch an assessment once the status says there is something to show:
  // a configured, healthy driver (stub counts — it serves the demo fixture).
  const showAssessment =
    status.data !== undefined && status.data.configured && status.data.healthy;
  const assessment = useApiQuery(
    showAssessment ? 'geo-intel:flood-risk' : null,
    () => fetchFloodRisk().then((res) => res.data),
    { enabled: showAssessment }
  );

  const driver = status.data?.driver;
  const live = status.data?.liveInference === true;
  const notConfigured =
    status.data !== undefined && (!status.data.configured || !status.data.healthy);

  return (
    <QueryState
      isLoading={status.isLoading}
      error={status.error}
      data={status.data}
      onRetry={status.refresh}
    >
      {notConfigured ? (
        <Card title={t('floodRisk.notConfiguredTitle')}>
          <p className="small muted">{t('floodRisk.notConfiguredNote')}</p>
          <p className="small muted">{status.data?.detail}</p>
          <StatusBadge tone="neutral">{driver === 'http' ? 'http driver' : 'stub driver'}</StatusBadge>
        </Card>
      ) : (
        <Card title={t('floodRisk.title')}>
          <QueryState
            isLoading={assessment.isLoading}
            error={assessment.error}
            data={assessment.data}
            onRetry={assessment.refresh}
          >
            {assessment.data ? (
              <>
                <div className="cluster">
                  <StatusBadge tone={severityTone(assessment.data.severity)}>
                    {t('floodRisk.severityLabel')}: {assessment.data.severity}
                  </StatusBadge>
                  <StatusBadge tone={live ? 'info' : 'neutral'}>
                    {live ? t('floodRisk.liveBadge') : t('floodRisk.demoBadge')}
                  </StatusBadge>
                </div>
                <p className="small muted" style={{ marginTop: '0.5rem' }}>
                  {t('floodRisk.floodedAreaLabel')}: {assessment.data.floodAreaKm2} km² (
                  {assessment.data.floodPercentage}%) · {t('floodRisk.confidenceLabel')}:{' '}
                  {Math.round(assessment.data.confidence * 100)}%
                </p>
                {assessment.data.plot ? (
                  <p className="small muted">
                    {t('floodRisk.plotLabel')}: {assessment.data.plot.name}
                  </p>
                ) : (
                  <p className="small muted">
                    {t('floodRisk.locationLabel')}: {assessment.data.assessedLocation.latitude},{' '}
                    {assessment.data.assessedLocation.longitude}
                  </p>
                )}
                {!live ? <p className="small muted">{t('floodRisk.demoNote')}</p> : null}
                <p className="small muted">{t('floodRisk.caveat')}</p>
              </>
            ) : null}
          </QueryState>
        </Card>
      )}
    </QueryState>
  );
}
