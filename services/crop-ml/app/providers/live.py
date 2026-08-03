"""Live ImageryProvider against a remote band-statistics API.

Contract: ``POST {SENTINEL_STATS_URL}/v1/plot-stats`` with JSON body
``{"plot_id", "season", "geometry"}`` and a Bearer token; the upstream
(e.g. a Sentinel Hub Statistical API adapter or COG-stats microservice)
answers ``{"series": [{"date", "red", "nir"}, ...]}``.

Fail-closed (mirrors docs/flood-ml.md):
  - 5 s timeout (configurable), ``retries`` additional attempts on
    transport errors and 5xx.
  - Circuit breaker: after ``circuit_fail_threshold`` consecutive failures
    the breaker opens for ``circuit_open_seconds`` and calls fail fast.
  - Any failure raises ImageryProviderError -> HTTP 503. The provider NEVER
    falls back to stub data.
"""
from __future__ import annotations

import time
from typing import Any, Callable

import httpx

from ..config import Settings
from ..models import BandSample
from .base import ImageryProvider, ImageryProviderError

STATS_PATH = "/v1/plot-stats"


class LiveImageryProvider(ImageryProvider):
    name = "live"

    def __init__(
        self,
        settings: Settings,
        client_factory: Callable[..., httpx.Client] = httpx.Client,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not settings.live_configured:
            raise ImageryProviderError(
                "IMAGERY_MISCONFIGURED",
                "live provider requires SENTINEL_STATS_URL and SENTINEL_STATS_TOKEN",
            )
        self._settings = settings
        self._clock = clock
        self._client = client_factory(
            base_url=settings.sentinel_stats_url.rstrip("/"),
            headers={"Authorization": f"Bearer {settings.sentinel_stats_token}"},
            timeout=httpx.Timeout(settings.http_timeout_seconds),
        )
        self._consecutive_failures = 0
        self._circuit_opened_at: float | None = None

    def circuit_state(self) -> str:
        return "open" if self._circuit_is_open() else "closed"

    def _circuit_is_open(self) -> bool:
        if self._circuit_opened_at is None:
            return False
        if self._clock() - self._circuit_opened_at >= self._settings.circuit_open_seconds:
            return False  # cooldown elapsed: next call is a trial (half-open)
        return True

    def _record_success(self) -> None:
        self._consecutive_failures = 0
        self._circuit_opened_at = None

    def _record_failure(self) -> None:
        self._consecutive_failures += 1
        if self._consecutive_failures >= self._settings.circuit_fail_threshold:
            self._circuit_opened_at = self._clock()

    def fetch_series(
        self,
        plot_id: str,
        season: str,
        geometry: dict[str, Any] | None = None,
    ) -> list[BandSample]:
        if self._circuit_is_open():
            raise ImageryProviderError(
                "IMAGERY_CIRCUIT_OPEN",
                f"imagery circuit open after {self._consecutive_failures} "
                "consecutive failures; fail-fast until cooldown elapses",
            )

        payload = {"plot_id": plot_id, "season": season, "geometry": geometry}
        attempts = 1 + self._settings.http_retries
        last_error: str = "unknown upstream failure"
        for _ in range(attempts):
            try:
                resp = self._client.post(STATS_PATH, json=payload)
            except httpx.HTTPError as exc:
                last_error = f"transport error: {exc!r}"
                continue
            if resp.status_code >= 500:
                last_error = f"upstream HTTP {resp.status_code}"
                continue
            if resp.status_code != 200:
                last_error = f"upstream HTTP {resp.status_code} (non-retryable)"
                break
            try:
                data = resp.json()
                series = [BandSample(**item) for item in data["series"]]
            except (ValueError, KeyError, TypeError) as exc:
                last_error = f"malformed upstream payload: {exc!r}"
                break
            self._record_success()
            return series

        self._record_failure()
        raise ImageryProviderError(
            "IMAGERY_PROVIDER_UNAVAILABLE",
            f"live imagery stats unavailable: {last_error}",
        )
