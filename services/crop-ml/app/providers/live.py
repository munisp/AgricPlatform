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
        async_client_factory: Callable[..., httpx.AsyncClient] = httpx.AsyncClient,
    ) -> None:
        if not settings.live_configured:
            raise ImageryProviderError(
                "IMAGERY_MISCONFIGURED",
                "live provider requires SENTINEL_STATS_URL and SENTINEL_STATS_TOKEN",
            )
        self._settings = settings
        self._clock = clock
        client_kwargs = dict(
            base_url=settings.sentinel_stats_url.rstrip("/"),
            headers={"Authorization": f"Bearer {settings.sentinel_stats_token}"},
            timeout=httpx.Timeout(settings.http_timeout_seconds),
        )
        self._client = client_factory(**client_kwargs)
        # Async twin of the sync client (identical base URL / auth / timeout):
        # used by fetch_series_async so the async request path never blocks
        # the event loop on upstream waits.
        self._async_client = async_client_factory(**client_kwargs)
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

    def _check_circuit(self) -> None:
        if self._circuit_is_open():
            raise ImageryProviderError(
                "IMAGERY_CIRCUIT_OPEN",
                f"imagery circuit open after {self._consecutive_failures} "
                "consecutive failures; fail-fast until cooldown elapses",
            )

    @staticmethod
    def _interpret(resp: httpx.Response) -> tuple[list[BandSample] | None, str | None, bool]:
        """Map an upstream response to (series, error, may_retry).

        5xx -> retryable; other non-200 -> terminal; malformed payload ->
        terminal. Identical rules for the sync and async fetch paths.
        """
        if resp.status_code >= 500:
            return None, f"upstream HTTP {resp.status_code}", True
        if resp.status_code != 200:
            return None, f"upstream HTTP {resp.status_code} (non-retryable)", False
        try:
            data = resp.json()
            return [BandSample(**item) for item in data["series"]], None, False
        except (ValueError, KeyError, TypeError) as exc:
            return None, f"malformed upstream payload: {exc!r}", False

    def _unavailable(self, last_error: str) -> ImageryProviderError:
        self._record_failure()
        return ImageryProviderError(
            "IMAGERY_PROVIDER_UNAVAILABLE",
            f"live imagery stats unavailable: {last_error}",
        )

    def fetch_series(
        self,
        plot_id: str,
        season: str,
        geometry: dict[str, Any] | None = None,
    ) -> list[BandSample]:
        self._check_circuit()

        payload = {"plot_id": plot_id, "season": season, "geometry": geometry}
        attempts = 1 + self._settings.http_retries
        last_error: str = "unknown upstream failure"
        for _ in range(attempts):
            try:
                resp = self._client.post(STATS_PATH, json=payload)
            except httpx.HTTPError as exc:
                last_error = f"transport error: {exc!r}"
                continue
            series, error, may_retry = self._interpret(resp)
            if series is not None:
                self._record_success()
                return series
            last_error = error or last_error
            if not may_retry:
                break

        raise self._unavailable(last_error)

    async def fetch_series_async(
        self,
        plot_id: str,
        season: str,
        geometry: dict[str, Any] | None = None,
    ) -> list[BandSample]:
        """Async twin of fetch_series via httpx.AsyncClient.

        Same timeout, retry count, circuit-breaker and fail-closed error
        semantics as the synchronous path — only the wait is non-blocking.
        """
        self._check_circuit()

        payload = {"plot_id": plot_id, "season": season, "geometry": geometry}
        attempts = 1 + self._settings.http_retries
        last_error: str = "unknown upstream failure"
        for _ in range(attempts):
            try:
                resp = await self._async_client.post(STATS_PATH, json=payload)
            except httpx.HTTPError as exc:
                last_error = f"transport error: {exc!r}"
                continue
            series, error, may_retry = self._interpret(resp)
            if series is not None:
                self._record_success()
                return series
            last_error = error or last_error
            if not may_retry:
                break

        raise self._unavailable(last_error)
