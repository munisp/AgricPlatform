"""Runtime configuration for the crop-ml sidecar.

`pydantic-settings` is not available in the target runtime, so settings are
a frozen dataclass populated from ``os.environ`` (same contract as pydantic
``BaseSettings``: environment variables are the canonical interface).

Fail-closed doctrine (mirrors ``docs/flood-ml.md``): when
``IMAGERY_PROVIDER=live`` is selected but the required upstream configuration
is missing, ``validate_settings`` raises and the service refuses to start.
It never silently falls back to the stub provider.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

SUPPORTED_PROVIDERS = ("stub", "live")

DEFAULT_HTTP_TIMEOUT_SECONDS = 5.0
DEFAULT_HTTP_RETRIES = 2
DEFAULT_CIRCUIT_FAIL_THRESHOLD = 5
DEFAULT_CIRCUIT_OPEN_SECONDS = 60.0


class ConfigError(RuntimeError):
    """Raised when the environment is misconfigured (fail-closed startup)."""


@dataclass(frozen=True)
class Settings:
    imagery_provider: str = "stub"
    sentinel_stats_url: str | None = None
    sentinel_stats_token: str | None = None
    http_timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS
    http_retries: int = DEFAULT_HTTP_RETRIES
    circuit_fail_threshold: int = DEFAULT_CIRCUIT_FAIL_THRESHOLD
    circuit_open_seconds: float = DEFAULT_CIRCUIT_OPEN_SECONDS
    port: int = 8100

    @property
    def live_configured(self) -> bool:
        return bool(self.sentinel_stats_url and self.sentinel_stats_token)


def _float(env: Mapping[str, str], key: str, default: float) -> float:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be a number, got {raw!r}") from exc


def _int(env: Mapping[str, str], key: str, default: int) -> int:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be an integer, got {raw!r}") from exc


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    provider = env.get("IMAGERY_PROVIDER", "stub").strip().lower()
    if provider not in SUPPORTED_PROVIDERS:
        raise ConfigError(
            f"IMAGERY_PROVIDER must be one of {SUPPORTED_PROVIDERS}, got {provider!r}"
        )
    return Settings(
        imagery_provider=provider,
        sentinel_stats_url=env.get("SENTINEL_STATS_URL") or None,
        sentinel_stats_token=env.get("SENTINEL_STATS_TOKEN") or None,
        http_timeout_seconds=_float(
            env, "SENTINEL_STATS_TIMEOUT_SECONDS", DEFAULT_HTTP_TIMEOUT_SECONDS
        ),
        http_retries=_int(env, "SENTINEL_STATS_RETRIES", DEFAULT_HTTP_RETRIES),
        circuit_fail_threshold=_int(
            env, "SENTINEL_STATS_CIRCUIT_THRESHOLD", DEFAULT_CIRCUIT_FAIL_THRESHOLD
        ),
        circuit_open_seconds=_float(
            env, "SENTINEL_STATS_CIRCUIT_OPEN_SECONDS", DEFAULT_CIRCUIT_OPEN_SECONDS
        ),
        port=_int(env, "PORT", 8100),
    )


def validate_settings(settings: Settings) -> None:
    """Fail-closed startup check: live mode requires full upstream config."""
    if settings.imagery_provider == "live" and not settings.live_configured:
        raise ConfigError(
            "IMAGERY_PROVIDER=live requires SENTINEL_STATS_URL and "
            "SENTINEL_STATS_TOKEN; refusing to start rather than silently "
            "serving stub data."
        )
