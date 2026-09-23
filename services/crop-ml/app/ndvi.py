"""NDVI computation from per-plot red/NIR band statistics.

NDVI = (NIR - RED) / (NIR + RED).  Pure math, no raster I/O: the service
never touches imagery files, it only consumes per-acquisition band means
supplied by an ImageryProvider or by the caller.
"""
from __future__ import annotations

import numpy as np

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
    """Vectorized equivalent of ``[round(ndvi_value(...), 6) for ...]``.

    BandSample constrains red/nir to finite values in [0, 1e6], so the only
    degenerate case is the zero-sum guard, replicated 1:1 via ``where=``.
    """
    if not samples:
        return []
    red = np.fromiter((s.red for s in samples), dtype=np.float64, count=len(samples))
    nir = np.fromiter((s.nir for s in samples), dtype=np.float64, count=len(samples))
    denom = nir + red
    values = np.zeros(len(samples), dtype=np.float64)
    np.divide(nir - red, denom, out=values, where=denom > 0.0)
    np.clip(values, -1.0, 1.0, out=values)
    return [float(v) for v in np.round(values, ROUND_DECIMALS)]


def mean_ndvi(values: list[float]) -> float:
    if not values:
        return 0.0
    return round(sum(values) / len(values), ROUND_DECIMALS)
