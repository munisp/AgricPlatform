"""ImageryProvider port.

The service never reads raster files (rasterio/GDAL are intentionally not
dependencies). Instead an ImageryProvider supplies per-plot, per-acquisition
band statistics (mean red/NIR reflectance). Implementations:

  - StubImageryProvider : deterministic synthetic series (default).
  - LiveImageryProvider : remote band-statistics API (e.g. Sentinel Hub
    Statistical API or a COG-stats microservice), fail-closed.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from ..models import BandSample


class ImageryProviderError(RuntimeError):
    """Machine-readable provider failure; surfaced to callers as HTTP 503."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ImageryProvider(ABC):
    name: str

    @abstractmethod
    def fetch_series(
        self,
        plot_id: str,
        season: str,
        geometry: dict[str, Any] | None = None,
    ) -> list[BandSample]:
        """Return per-acquisition band statistics for a plot and season.

        Must raise ImageryProviderError on any failure — implementations
        never substitute synthetic data for a failed live fetch.
        """

    def circuit_state(self) -> str:
        """Breaker state for readiness reporting ('closed'/'open'/'n/a')."""
        return "n/a"
