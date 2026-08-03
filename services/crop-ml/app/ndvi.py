"""NDVI computation from per-plot red/NIR band statistics.

NDVI = (NIR - RED) / (NIR + RED).  Pure math, no raster I/O: the service
never touches imagery files, it only consumes per-acquisition band means
supplied by an ImageryProvider or by the caller.
"""
from __future__ import annotations

from .models import BandSample

ROUND_DECIMALS = 6


def ndvi_value(red: float, nir: float) -> float:
    """Single-observation NDVI, guarded against degenerate input."""
    denom = nir + red
    if denom <= 0.0:
        return 0.0
    value = (nir - red) / denom
    return max(-1.0, min(1.0, value))


def ndvi_series(samples: list[BandSample]) -> list[float]:
    return [round(ndvi_value(s.red, s.nir), ROUND_DECIMALS) for s in samples]


def mean_ndvi(values: list[float]) -> float:
    if not values:
        return 0.0
    return round(sum(values) / len(values), ROUND_DECIMALS)
