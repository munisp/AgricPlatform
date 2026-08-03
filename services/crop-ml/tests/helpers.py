"""Shared fixtures for crop-ml tests."""
from __future__ import annotations

import datetime as dt

import numpy as np

from app.models import BandSample
from app.providers.stub import canonical_reference_series, samples_from_ndvi


def synthetic_curve(
    n: int = 40,
    cadence: int = 5,
    start: dt.date = dt.date(2024, 3, 1),
    base: float = 0.12,
    amp: float = 0.55,
    sos_day: float = 45.0,
    eos_day: float = 170.0,
    rise: float = 12.0,
    fall: float = 15.0,
) -> list[BandSample]:
    """Noise-free logistic seasonal NDVI curve with known SOS/EOS windows."""
    t = np.arange(n, dtype=float) * cadence
    rise_limb = 1.0 / (1.0 + np.exp(-(t - sos_day) / rise))
    fall_limb = 1.0 / (1.0 + np.exp(-(t - eos_day) / fall))
    ndvi = np.clip(base + amp * (rise_limb - fall_limb), 0.02, 0.95)
    dates = [start + dt.timedelta(days=int(x)) for x in t]
    return samples_from_ndvi(dates, ndvi)


def reference_curve() -> list[BandSample]:
    return canonical_reference_series("2024")
