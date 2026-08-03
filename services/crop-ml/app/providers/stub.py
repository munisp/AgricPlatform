"""Deterministic synthetic ImageryProvider (default).

Generates a logistic seasonal NDVI profile with seeded noise, then derives
consistent red/NIR band means from it. The seed is a SHA-256 digest of
``plot_id|season`` (NOT Python's salted builtin ``hash()``), so the same
plot+season yields the identical series on every call, in every process.

This is a development/CI fixture. Responses carry ``provider: "stub"`` so
consumers can tell simulated data from live statistics.
"""
from __future__ import annotations

import datetime as dt
import hashlib
from typing import Any

import numpy as np

from ..models import BandSample
from .base import ImageryProvider

NUM_ACQUISITIONS = 45
CADENCE_DAYS = 5
BASE_NDVI = 0.12
AMPLITUDE = 0.55
SOS_DAY = 45.0
EOS_DAY = 170.0
RISE_DAYS = 12.0
FALL_DAYS = 15.0
NOISE_SIGMA = 0.01
NIR_MEAN = 0.45


def stable_seed(plot_id: str, season: str) -> int:
    digest = hashlib.sha256(f"{plot_id}|{season}".encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "little") & 0xFFFFFFFF


def season_start(season: str) -> dt.date:
    year = int(season[:4])
    if season.endswith("-dry"):
        return dt.date(year, 10, 1)
    return dt.date(year, 3, 1)


def _logistic(t: np.ndarray, center: float, scale: float) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-(t - center) / scale))


def logistic_ndvi(t: np.ndarray, rng: np.random.Generator | None = None) -> np.ndarray:
    """Canonical seasonal profile; seeded per-plot jitter when rng given."""
    jitter = (lambda lo, hi: float(rng.uniform(lo, hi))) if rng is not None else (lambda lo, hi: 0.0)
    amp = AMPLITUDE + jitter(-0.05, 0.05)
    sos = SOS_DAY + jitter(-8.0, 8.0)
    eos = EOS_DAY + jitter(-8.0, 8.0)
    rise = RISE_DAYS + jitter(-2.0, 2.0)
    fall = FALL_DAYS + jitter(-2.0, 2.0)
    ndvi = BASE_NDVI + amp * (_logistic(t, sos, rise) - _logistic(t, eos, fall))
    if rng is not None:
        ndvi = ndvi + rng.normal(0.0, NOISE_SIGMA, size=t.shape)
    return np.clip(ndvi, 0.02, 0.92)


def samples_from_ndvi(dates: list[dt.date], ndvi: np.ndarray) -> list[BandSample]:
    """Derive red/NIR band means consistent with the target NDVI."""
    samples: list[BandSample] = []
    for d, v in zip(dates, ndvi):
        nir = NIR_MEAN
        red = nir * (1.0 - float(v)) / (1.0 + float(v))
        samples.append(BandSample(date=d, red=round(red, 6), nir=nir))
    return samples


def canonical_reference_series(season: str) -> list[BandSample]:
    """Noise-free canonical seasonal profile used as the health baseline."""
    start = season_start(season)
    t = np.arange(NUM_ACQUISITIONS, dtype=float) * CADENCE_DAYS
    dates = [start + dt.timedelta(days=int(x)) for x in t]
    return samples_from_ndvi(dates, logistic_ndvi(t))


class StubImageryProvider(ImageryProvider):
    name = "stub"

    def fetch_series(
        self,
        plot_id: str,
        season: str,
        geometry: dict[str, Any] | None = None,
    ) -> list[BandSample]:
        rng = np.random.default_rng(stable_seed(plot_id, season))
        start = season_start(season)
        t = np.arange(NUM_ACQUISITIONS, dtype=float) * CADENCE_DAYS
        dates = [start + dt.timedelta(days=int(x)) for x in t]
        return samples_from_ndvi(dates, logistic_ndvi(t, rng))
