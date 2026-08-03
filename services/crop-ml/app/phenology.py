"""Phenology extraction from an NDVI time series.

Method (fixed, deterministic):
  1. Savitzky-Golay smoothing of the acquisition-cadence NDVI series
     (window = largest odd number <= min(11, n), polyorder = 2).
  2. Linear interpolation of the smoothed curve onto a daily grid.
  3. Base = grid minimum, peak = grid maximum, amplitude = peak - base.
  4. SOS = first day the smoothed curve reaches base + 20% of amplitude;
     EOS = last day it is at or above that threshold (TIMESAT-style
     amplitude method).

Series shorter than ``MIN_ACQUISITIONS`` are rejected: smoothing and
threshold crossings are not meaningful below that.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

import numpy as np
from scipy.signal import savgol_filter

MIN_ACQUISITIONS = 6
SAVGOL_POLYORDER = 2
SAVGOL_MAX_WINDOW = 11
AMPLITUDE_FRACTION = 0.2


@dataclass(frozen=True)
class Phenology:
    sos_date: dt.date
    eos_date: dt.date
    peak_date: dt.date
    peak_value: float
    base_value: float
    amplitude: float
    season_length_days: int


def savgol_window(n: int) -> int:
    """Largest odd window <= min(SAVGOL_MAX_WINDOW, n), at least 3."""
    w = min(SAVGOL_MAX_WINDOW, n if n % 2 == 1 else n - 1)
    return max(3, w)


def smooth(values: list[float]) -> np.ndarray:
    n = len(values)
    if n < 3:
        return np.asarray(values, dtype=float)
    window = savgol_window(n)
    polyorder = min(SAVGOL_POLYORDER, window - 1)
    return savgol_filter(np.asarray(values, dtype=float), window, polyorder)


def compute_phenology(dates: list[dt.date], ndvi: list[float]) -> Phenology:
    if len(dates) != len(ndvi):
        raise ValueError("dates and ndvi must have the same length")
    n = len(dates)
    if n < MIN_ACQUISITIONS:
        raise ValueError(
            f"at least {MIN_ACQUISITIONS} acquisitions required, got {n}"
        )
    order = np.argsort(np.asarray([d.toordinal() for d in dates], dtype=np.int64), kind="stable")
    dates = [dates[i] for i in order]
    y = smooth([ndvi[i] for i in order])

    origin = dates[0]
    x = np.asarray([(d - origin).days for d in dates], dtype=float)
    grid = np.arange(0.0, x[-1] + 1.0, 1.0)
    gy = np.interp(grid, x, y)

    base = float(gy.min())
    peak = float(gy.max())
    amplitude = peak - base
    threshold = base + AMPLITUDE_FRACTION * amplitude
    above = gy >= threshold
    peak_idx = int(np.argmax(gy))
    if not above.any():
        sos_idx = eos_idx = peak_idx
    else:
        idx = np.flatnonzero(above)
        sos_idx, eos_idx = int(idx[0]), int(idx[-1])

    return Phenology(
        sos_date=origin + dt.timedelta(days=int(grid[sos_idx])),
        eos_date=origin + dt.timedelta(days=int(grid[eos_idx])),
        peak_date=origin + dt.timedelta(days=int(grid[peak_idx])),
        peak_value=round(peak, 6),
        base_value=round(base, 6),
        amplitude=round(amplitude, 6),
        season_length_days=int(grid[eos_idx] - grid[sos_idx]),
    )


def day_of_year(d: dt.date) -> int:
    return d.timetuple().tm_yday
