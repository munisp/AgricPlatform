"""OpenTelemetry wiring: the app must boot and serve regardless of collector state."""
from __future__ import annotations

import time

from fastapi.testclient import TestClient

from app.main import create_app
from app.telemetry import _server_request_hook, otel_enabled, setup_telemetry


def test_otel_enabled_flag_semantics() -> None:
    assert otel_enabled({}) is True  # default on, no-op-safe
    for value in ("false", "FALSE", "0", "no", "off"):
        assert otel_enabled({"OTEL_ENABLED": value}) is False


def test_app_boots_and_serves_with_otel_disabled(monkeypatch) -> None:
    monkeypatch.setenv("OTEL_ENABLED", "false")
    app = create_app()
    client = TestClient(app)
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_app_boots_and_serves_with_dead_collector(monkeypatch) -> None:
    """Collector down = warn, app continues (and must not hang)."""
    monkeypatch.setenv("OTEL_ENABLED", "true")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_TIMEOUT", "1")
    monkeypatch.setenv("OTEL_BSP_EXPORT_TIMEOUT", "1")
    start = time.monotonic()
    app = create_app()
    client = TestClient(app)
    resp = client.get("/healthz", headers={"x-tenant-id": "tenant-42"})
    elapsed = time.monotonic() - start
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
    assert elapsed < 5.0
    app.state.otel_shutdown()


def test_tenant_header_hook_sets_span_attribute() -> None:
    class _Span:
        def __init__(self) -> None:
            self.attrs = {}

        def set_attribute(self, key, value) -> None:
            self.attrs[key] = value

    span = _Span()
    _server_request_hook(span, {"headers": [(b"x-tenant-id", b"tenant-42")]})
    assert span.attrs == {"tenant.id": "tenant-42"}

    span2 = _Span()
    _server_request_hook(span2, {"headers": [(b"content-type", b"application/json")]})
    assert span2.attrs == {}
    _server_request_hook(None, {"headers": [(b"x-tenant-id", b"t")]})  # no-op


def test_setup_telemetry_disabled_returns_noop_shutdown() -> None:
    app = create_app(settings=None, validate_config=False)
    shutdown = setup_telemetry(app, env={"OTEL_ENABLED": "false"})
    shutdown()  # must not raise
