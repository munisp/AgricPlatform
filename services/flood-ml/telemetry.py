"""OpenTelemetry wiring for the flood-ml sidecar.

No-op-safe contract (mirrors services/event-gw and services/geo-compute):

- ``OTEL_ENABLED`` (default ``true``): any of ``false|0|no|off`` disables
  telemetry entirely — no SDK is constructed, the app is untouched.
- ``OTEL_EXPORTER_OTLP_ENDPOINT`` (default ``http://localhost:4318``): OTLP/HTTP
  collector base URL. When the collector is absent the batch span processor
  only logs export warnings; the app never blocks or crashes.
- ``OTEL_SERVICE_NAME`` (default ``flood-ml``): ``service.name`` resource attr.

Every request span carries ``tenant.id`` when the inbound ``x-tenant-id``
header is present. Log records get trace-context fields via the logging
instrumentor; outbound ``requests`` calls (Sentinel Hub) are traced.
``setup_telemetry`` returns a shutdown callable (flushes and stops the
provider); it is also wired to the FastAPI ``shutdown`` event.
"""
from __future__ import annotations

import logging
import os
from typing import Callable, Mapping

logger = logging.getLogger("flood-ml.telemetry")

DEFAULT_OTLP_ENDPOINT = "http://localhost:4318"
TENANT_ID_HEADER = b"x-tenant-id"

_DISABLED_VALUES = {"false", "0", "no", "off"}


def otel_enabled(env: Mapping[str, str]) -> bool:
    """OTEL_ENABLED defaults to true; only explicit negative values disable."""
    raw = (env.get("OTEL_ENABLED") or "").strip().lower()
    return raw not in _DISABLED_VALUES


def _server_request_hook(span, scope: dict) -> None:
    """Propagate the inbound x-tenant-id header onto the server span."""
    if span is None:
        return
    for key, value in scope.get("headers") or []:
        if key.lower() == TENANT_ID_HEADER:
            try:
                span.set_attribute("tenant.id", value.decode("utf-8", "replace"))
            except Exception:  # pragma: no cover - defensive; never break requests
                pass
            return


def setup_telemetry(
    app,
    *,
    service_name: str = "flood-ml",
    env: Mapping[str, str] | None = None,
) -> Callable[[], None]:
    """Instrument *app*; return a shutdown callable. Never raises."""
    env = os.environ if env is None else env

    if not otel_enabled(env):
        logger.info("OTEL_ENABLED is disabled; OpenTelemetry instrumentation skipped")
        return lambda: None

    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.logging import LoggingInstrumentor
        from opentelemetry.instrumentation.requests import RequestsInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError as exc:  # pragma: no cover - depends on runtime env
        logger.warning("OpenTelemetry packages unavailable (%s); telemetry disabled", exc)
        return lambda: None

    endpoint = (env.get("OTEL_EXPORTER_OTLP_ENDPOINT") or DEFAULT_OTLP_ENDPOINT).rstrip("/")
    name = env.get("OTEL_SERVICE_NAME") or service_name

    try:
        provider = TracerProvider(resource=Resource.create({"service.name": name}))
        exporter = OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces")
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)

        LoggingInstrumentor().instrument()
        RequestsInstrumentor().instrument()
        FastAPIInstrumentor.instrument_app(app, server_request_hook=_server_request_hook)
    except Exception as exc:  # never fatal: collector/SDK issues must not stop the app
        logger.warning("OpenTelemetry setup failed (%s); continuing without telemetry", exc)
        return lambda: None

    def shutdown() -> None:
        try:
            provider.shutdown()
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("OpenTelemetry shutdown failed: %s", exc)

    app.add_event_handler("shutdown", shutdown)
    logger.info("OpenTelemetry enabled: service=%s endpoint=%s", name, endpoint)
    return shutdown
