"""Orchestration: NDVI -> phenology -> classification / health scoring."""
from __future__ import annotations

from functools import lru_cache
from typing import Any

import anyio

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


# One full NDVI -> phenology analysis of a series.
Analysis = tuple[list[NdviPoint], Phenology, float]


def _seasonality_response(
    plot_id: str,
    acquisitions: int,
    series_an: Analysis,
    ref_an: Analysis | None,
) -> SeasonalityResponse:
    points, phen, mean_v = series_an
    ref_metrics: PhenologyMetrics | None = None
    ref_phen: Phenology | None = None
    ref_mean: float | None = None
    if ref_an is not None:
        _, ref_phen, ref_mean = ref_an
        ref_metrics = _metrics(ref_phen)
    cls = anomaly.classify_season(phen, mean_v, ref_phen, ref_mean)
    return SeasonalityResponse(
        plot_id=plot_id,
        acquisitions=acquisitions,
        ndvi=points,
        phenology=_metrics(phen),
        mean_ndvi=mean_v,
        reference_phenology=ref_metrics,
        classification=SeasonClassification(label=cls.label, reason_codes=cls.reason_codes),
    )


def _health_response(
    plot_id: str,
    cur_an: Analysis,
    base_an: Analysis,
) -> HealthScoreResponse:
    _, cur_phen, cur_mean = cur_an
    _, base_phen, base_mean = base_an
    score, drivers = anomaly.health_score(cur_phen, cur_mean, base_phen, base_mean)
    return HealthScoreResponse(
        plot_id=plot_id,
        score=score,
        drivers=[HealthDriver(code=d.code, impact=d.impact, detail=d.detail) for d in drivers],
        current_phenology=_metrics(cur_phen),
        baseline_phenology=_metrics(base_phen),
    )


def seasonality_analysis(
    plot_id: str,
    series: list[BandSample],
    reference: list[BandSample] | None = None,
) -> SeasonalityResponse:
    ref_an = _analyze(reference) if reference is not None else None
    return _seasonality_response(plot_id, len(series), _analyze(series), ref_an)


def health_score_analysis(
    plot_id: str,
    current: list[BandSample],
    baseline: list[BandSample],
) -> HealthScoreResponse:
    return _health_response(plot_id, _analyze(current), _analyze(baseline))


@lru_cache(maxsize=64)
def _canonical_reference_analysis(season: str) -> Analysis:
    """Analysis of the canonical noise-free baseline for a season.

    canonical_reference_series(season) is deterministic per season string
    (hashable), so the result is cached instead of rebuilt every request.
    """
    return _analyze(canonical_reference_series(season))


def _assess_from_series(
    provider_name: str,
    plot_id: str,
    season: str,
    series: list[BandSample],
) -> AssessPlotResponse:
    """Shared assess-plot compute: each series is analysed exactly once."""
    series_an = _analyze(series)
    base_an = _canonical_reference_analysis(season)
    seasonality = _seasonality_response(plot_id, len(series), series_an, base_an)
    health = _health_response(plot_id, series_an, base_an)
    return AssessPlotResponse(
        plot_id=plot_id,
        season=season,
        provider=provider_name,
        seasonality=seasonality,
        health=health,
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
    return _assess_from_series(provider.name, plot_id, season, series)


async def assess_plot_async(
    provider: ImageryProvider,
    plot_id: str,
    season: str,
    geometry: dict[str, Any] | None = None,
) -> AssessPlotResponse:
    """Async variant of assess_plot.

    Uses the provider's async fetch when available (live provider: non-blocking
    httpx.AsyncClient), otherwise runs the synchronous fetch in a worker
    thread; the CPU-bound pipeline always runs in a worker thread so the
    event loop is never blocked.
    """
    fetch_async = getattr(provider, "fetch_series_async", None)
    if fetch_async is not None:
        series = await fetch_async(plot_id, season, geometry)
    else:
        series = await anyio.to_thread.run_sync(
            provider.fetch_series, plot_id, season, geometry
        )
    return await anyio.to_thread.run_sync(
        _assess_from_series, provider.name, plot_id, season, series
    )


def parse_season_year(season: str) -> int:
    return int(season[:4])
