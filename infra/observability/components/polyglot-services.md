# Polyglot service telemetry — env snippets (wave W4 snippet)

App-side SDK wiring belongs to W5 (`services/*`); this file is the env-only
half. Every service below exports OTLP to the hub collector and is scraped or
traced as noted.

## Rust — `geo-compute` (axum, :8200)

```yaml
# environment: additions for the geo-compute compose service (integrator: W3)
OTEL_SERVICE_NAME: geo-compute
OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317
OTEL_EXPORTER_OTLP_PROTOCOL: grpc
OTEL_TRACES_SAMPLER: parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG: "1.0"          # dev: all; prod: 0.1
```

W5 adds `tracing` + `tracing-opentelemetry` tower layer
(`services/geo-compute/src/handlers.rs:34`) and a `/metrics` route; the hub
collector job `geo-compute` scrapes `geo-compute:8200/metrics` once it exists.

## Go — `event-gw` (stdlib net/http, :8090)

```yaml
OTEL_SERVICE_NAME: event-gw
OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317
OTEL_EXPORTER_OTLP_PROTOCOL: grpc
OTEL_PROPAGATORS: tracecontext,baggage
```

W5 wraps the mux with `otelhttp` (`internal/gateway/server.go:47`). Metrics
already exist natively (`GET /metrics`, plaintext circuit-breaker state) and
are scraped by collector job `event-gw` — no code change needed for that half.

## Python — `flood-ml` (:8001) and `crop-ml` (:8100)

```yaml
OTEL_SERVICE_NAME: flood-ml            # or crop-ml
OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317
OTEL_EXPORTER_OTLP_PROTOCOL: grpc
OTEL_TRACES_SAMPLER: parentbased_always_on
```

W5 adds `opentelemetry-distro` + `FastAPIInstrumentor`
(`services/flood-ml/app.py:52`, `services/crop-ml/app/main.py` `create_app()`).
Neither service exposes `/metrics` today; if prometheus scraping is preferred
over OTLP metrics, W5 can add `prometheus-fastapi-instrumentator` and a
collector scrape job can be appended to `../otel-collector-config.yaml`.

## NestJS — `api` / temporal worker (:3001)

```yaml
OTEL_SERVICE_NAME: agric-api           # worker: agric-temporal-worker
OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317
OTEL_EXPORTER_OTLP_PROTOCOL: grpc
OTEL_TRACES_SAMPLER: parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG: "1.0"
```

Owned by stage 25.1 (`apps/api/src/common/telemetry/`). The existing
METRICS_TOKEN-guarded `/api/v1/metrics` endpoint and the existing
`prometheus.yml` job stay untouched — Prometheus pull and OTLP push coexist.
