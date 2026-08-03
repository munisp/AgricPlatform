"""Season classification and plot health scoring.

Classification (``classify_season``):
  - stressed : low absolute peak NDVI, or large peak/mean deficit vs the
    reference season.
  - delayed  : start of season > DELAY_DAYS_THRESHOLD day-of-year days later
    than the reference (and not already stressed).
  - normal   : otherwise.

Health score (``health_score``): starts at 100 and subtracts deterministic,
driver-attributed penalties computed from deltas between the current and
baseline phenology. Every point subtracted is named by exactly one driver.
Thresholds are literature-typical defaults and require local calibration
(see README, "Honest limitations").
"""
from __future__ import annotations

from dataclasses import dataclass

from .phenology import Phenology, day_of_year

# Classification thresholds (agronomic defaults, calibrate locally).
LOW_ABSOLUTE_PEAK = 0.30
PEAK_DEFICIT_THRESHOLD = 0.15
MEAN_DEFICIT_THRESHOLD = 0.10
DELAY_DAYS_THRESHOLD = 14

# Health-score penalty caps (points).
CAP_PEAK_DEFICIT = 40.0
CAP_MEAN_DEFICIT = 15.0
CAP_LATE_SOS = 20.0
CAP_EARLY_EOS = 15.0
CAP_LOW_ABSOLUTE_PEAK = 25.0

DRIVER_MIN_IMPACT = 0.05


@dataclass(frozen=True)
class Classification:
    label: str
    reason_codes: list[str]


@dataclass(frozen=True)
class Driver:
    code: str
    impact: float
    detail: str


def classify_season(
    current: Phenology,
    current_mean_ndvi: float,
    reference: Phenology | None = None,
    reference_mean_ndvi: float | None = None,
) -> Classification:
    codes: list[str] = []

    if current.peak_value < LOW_ABSOLUTE_PEAK:
        codes.append("PEAK_NDVI_LOW")
    if reference is not None:
        if reference.peak_value - current.peak_value > PEAK_DEFICIT_THRESHOLD:
            codes.append("PEAK_NDVI_DEFICIT_VS_REFERENCE")
        if (
            reference_mean_ndvi is not None
            and reference_mean_ndvi - current_mean_ndvi > MEAN_DEFICIT_THRESHOLD
        ):
            codes.append("MEAN_NDVI_DEFICIT")

    if codes:
        return Classification(label="stressed", reason_codes=codes)

    if reference is not None:
        delay = day_of_year(current.sos_date) - day_of_year(reference.sos_date)
        if delay > DELAY_DAYS_THRESHOLD:
            return Classification(label="delayed", reason_codes=["SOS_DELAYED"])

    return Classification(label="normal", reason_codes=[])


def health_score(
    current: Phenology,
    current_mean_ndvi: float,
    baseline: Phenology,
    baseline_mean_ndvi: float,
) -> tuple[float, list[Driver]]:
    """0-100 score plus drivers derived from current-vs-baseline deltas."""
    drivers: list[Driver] = []

    peak_deficit = max(0.0, baseline.peak_value - current.peak_value)
    if peak_deficit > 0.0:
        impact = min(CAP_PEAK_DEFICIT, peak_deficit * 100.0)
        drivers.append(
            Driver(
                code="peak_ndvi_deficit",
                impact=impact,
                detail=(
                    f"peak NDVI {current.peak_value:.3f} vs baseline "
                    f"{baseline.peak_value:.3f} (deficit {peak_deficit:.3f})"
                ),
            )
        )

    mean_deficit = max(0.0, baseline_mean_ndvi - current_mean_ndvi)
    if mean_deficit > 0.0:
        impact = min(CAP_MEAN_DEFICIT, mean_deficit * 100.0)
        drivers.append(
            Driver(
                code="mean_ndvi_deficit",
                impact=impact,
                detail=(
                    f"season mean NDVI {current_mean_ndvi:.3f} vs baseline "
                    f"{baseline_mean_ndvi:.3f} (deficit {mean_deficit:.3f})"
                ),
            )
        )

    sos_delay = max(0, day_of_year(current.sos_date) - day_of_year(baseline.sos_date))
    if sos_delay > 0:
        impact = min(CAP_LATE_SOS, float(sos_delay))
        drivers.append(
            Driver(
                code="late_sos",
                impact=impact,
                detail=f"start of season {sos_delay} day-of-year days later than baseline",
            )
        )

    eos_early = max(0, day_of_year(baseline.eos_date) - day_of_year(current.eos_date))
    if eos_early > 0:
        impact = min(CAP_EARLY_EOS, eos_early * 0.5)
        drivers.append(
            Driver(
                code="early_eos",
                impact=impact,
                detail=f"end of season {eos_early} day-of-year days earlier than baseline",
            )
        )

    if current.peak_value < LOW_ABSOLUTE_PEAK:
        impact = min(CAP_LOW_ABSOLUTE_PEAK, (LOW_ABSOLUTE_PEAK - current.peak_value) * 100.0)
        drivers.append(
            Driver(
                code="low_absolute_peak",
                impact=impact,
                detail=(
                    f"peak NDVI {current.peak_value:.3f} below absolute vigor "
                    f"floor {LOW_ABSOLUTE_PEAK:.2f}"
                ),
            )
        )

    drivers = [d for d in drivers if d.impact > DRIVER_MIN_IMPACT]
    drivers.sort(key=lambda d: (-d.impact, d.code))
    total_penalty = sum(d.impact for d in drivers)
    score = round(max(0.0, 100.0 - total_penalty), 2)
    rounded = [Driver(code=d.code, impact=round(d.impact, 2), detail=d.detail) for d in drivers]
    return score, rounded
