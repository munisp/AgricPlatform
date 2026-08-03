"""Orchestration: NDVI -> phenology -> classification / health scoring."""
from __future__ import annotations

from typing import Any

from . import anomaly, ndvi
from .models import (
    AssessPlotResponse,
    BandSample,
    HealthDriver,
    HealthScoreResponse,
    NdviPoint,
    PhenologyMetrics,
    SeasonalityResponse,
    SeasonClassification,
)
from .phenology import Phenology, compute_phenology
from .providers.base import ImageryProvider
from .providers.stub import canonical_reference_series


def _sorted_unique(samples: list[BandSample]) -> list[BandSample]:
    ordered = sorted(samples, key=lambda s: s.date)
    dates = [s.date for s in ordered]
    if len(set(dates)) != len(dates):
        raise ValueError("series contains duplicate acquisition dates")
    return ordered


def _metrics(p: Phenology) -> PhenologyMetrics:
    return PhenologyMetrics(
        sos_date=p.sos_date,
        eos_date=p.eos_date,
        peak_date=p.peak_date,
        peak_value=p.peak_value,
        base_value=p.base_value,
        amplitude=p.amplitude,
        season_length_days=p.season_length_days,
    )


def _analyze(samples: list[BandSample]) -> tuple[list[NdviPoint], Phenology, float]:
    ordered = _sorted_unique(samples)
    values = ndvi.ndvi_series(ordered)
    phen = compute_phenology([s.date for s in ordered], values)
    points = [NdviPoint(date=s.date, ndvi=v) for s, v in zip(ordered, values)]
    return points, phen, ndvi.mean_ndvi(values)


def seasonality_analysis(
    plot_id: str,
    series: list[BandSample],
    reference: list[BandSample] | None = None,
) -> SeasonalityResponse:
    points, phen, mean_v = _analyze(series)
    ref_metrics: PhenologyMetrics | None = None
    ref_phen: Phenology | None = None
    ref_mean: float | None = None
    if reference is not None:
        _, ref_phen, ref_mean = _analyze(reference)
        ref_metrics = _metrics(ref_phen)
    cls = anomaly.classify_season(phen, mean_v, ref_phen, ref_mean)
    return SeasonalityResponse(
        plot_id=plot_id,
        acquisitions=len(series),
        ndvi=points,
        phenology=_metrics(phen),
        mean_ndvi=mean_v,
        reference_phenology=ref_metrics,
        classification=SeasonClassification(label=cls.label, reason_codes=cls.reason_codes),
    )


def health_score_analysis(
    plot_id: str,
    current: list[BandSample],
    baseline: list[BandSample],
) -> HealthScoreResponse:
    _, cur_phen, cur_mean = _analyze(current)
    _, base_phen, base_mean = _analyze(baseline)
    score, drivers = anomaly.health_score(cur_phen, cur_mean, base_phen, base_mean)
    return HealthScoreResponse(
        plot_id=plot_id,
        score=score,
        drivers=[HealthDriver(code=d.code, impact=d.impact, detail=d.detail) for d in drivers],
        current_phenology=_metrics(cur_phen),
        baseline_phenology=_metrics(base_phen),
    )


def assess_plot(
    provider: ImageryProvider,
    plot_id: str,
    season: str,
    geometry: dict[str, Any] | None = None,
) -> AssessPlotResponse:
    """Integration endpoint used by the NestJS API.

    Fetches band statistics from the configured provider (fail-closed), then
    runs seasonality + health scoring against the canonical noise-free
    seasonal profile for that season as baseline.
    """
    series = provider.fetch_series(plot_id, season, geometry)
    baseline = canonical_reference_series(season)
    seasonality = seasonality_analysis(plot_id, series, reference=baseline)
    health = health_score_analysis(plot_id, series, baseline)
    return AssessPlotResponse(
        plot_id=plot_id,
        season=season,
        provider=provider.name,
        seasonality=seasonality,
        health=health,
    )


def parse_season_year(season: str) -> int:
    return int(season[:4])
