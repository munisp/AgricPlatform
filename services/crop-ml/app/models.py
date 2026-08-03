"""Pydantic request/response schemas for the crop-ml API.

All float fields that leave the service are rounded to ``ROUND_DECIMALS``
by the service layer so responses are byte-identical for identical input.
"""
from __future__ import annotations

import datetime as dt
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MIN_ACQUISITIONS = 6
MAX_ACQUISITIONS = 500
SEASON_PATTERN = re.compile(r"^\d{4}(-(wet|dry))?$")


class BandSample(BaseModel):
    """Per-acquisition band statistics for one plot (mean reflectance)."""

    model_config = ConfigDict(extra="forbid")

    date: dt.date
    red: float = Field(ge=0.0, le=1_000_000.0)
    nir: float = Field(ge=0.0, le=1_000_000.0)


class NdviPoint(BaseModel):
    date: dt.date
    ndvi: float


class PhenologyMetrics(BaseModel):
    sos_date: dt.date = Field(description="Start of season (20% amplitude crossing)")
    eos_date: dt.date = Field(description="End of season (last 20% amplitude crossing)")
    peak_date: dt.date
    peak_value: float
    base_value: float
    amplitude: float
    season_length_days: int


class SeasonClassification(BaseModel):
    label: Literal["normal", "delayed", "stressed"]
    reason_codes: list[str]


class SeasonalityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plot_id: str = Field(min_length=1, max_length=128)
    series: list[BandSample] = Field(min_length=MIN_ACQUISITIONS, max_length=MAX_ACQUISITIONS)
    reference: list[BandSample] | None = Field(
        default=None, min_length=MIN_ACQUISITIONS, max_length=MAX_ACQUISITIONS
    )

    @model_validator(mode="after")
    def _unique_dates(self) -> "SeasonalityRequest":
        _assert_unique_dates(self.series, "series")
        if self.reference is not None:
            _assert_unique_dates(self.reference, "reference")
        return self


class SeasonalityResponse(BaseModel):
    plot_id: str
    acquisitions: int
    ndvi: list[NdviPoint]
    phenology: PhenologyMetrics
    mean_ndvi: float
    reference_phenology: PhenologyMetrics | None
    classification: SeasonClassification


class HealthScoreRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plot_id: str = Field(min_length=1, max_length=128)
    current: list[BandSample] = Field(min_length=MIN_ACQUISITIONS, max_length=MAX_ACQUISITIONS)
    baseline: list[BandSample] = Field(min_length=MIN_ACQUISITIONS, max_length=MAX_ACQUISITIONS)

    @model_validator(mode="after")
    def _unique_dates(self) -> "HealthScoreRequest":
        _assert_unique_dates(self.current, "current")
        _assert_unique_dates(self.baseline, "baseline")
        return self


class HealthDriver(BaseModel):
    code: str
    impact: float = Field(description="Points subtracted from the 0-100 score")
    detail: str


class HealthScoreResponse(BaseModel):
    plot_id: str
    score: float = Field(ge=0.0, le=100.0)
    drivers: list[HealthDriver]
    current_phenology: PhenologyMetrics
    baseline_phenology: PhenologyMetrics


class AssessPlotRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plot_id: str = Field(min_length=1, max_length=128)
    geometry: dict[str, Any] | None = None
    season: str = Field(pattern=SEASON_PATTERN)


class AssessPlotResponse(BaseModel):
    plot_id: str
    season: str
    provider: str
    seasonality: SeasonalityResponse
    health: HealthScoreResponse


class ReadyResponse(BaseModel):
    status: Literal["ready", "misconfigured"]
    provider: dict[str, str]


def _assert_unique_dates(samples: list[BandSample], field: str) -> None:
    dates = [s.date for s in samples]
    if len(set(dates)) != len(dates):
        raise ValueError(f"{field} contains duplicate acquisition dates")
