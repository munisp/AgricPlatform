# Trino telemetry (wave W4 snippet)

Compose service: `trino` (profile `lakehouse-query`, `trinodb/trino`, `agric-trino`, :8080).

## Traces — native OpenTelemetry (Trino >= 436)

Append to the coordinator `config.properties` (the compose image generates one;
mount an override next to `infra/trino/catalog` or extend the entrypoint):

```properties
# Native OTel tracing — coordinator + workers emit query/optimizer spans.
tracing.enabled=true
otel.exporter.endpoint=http://otel-collector:4317
otel.exporter.protocol=grpc            # or http/protobuf (-> :4318)
otel.tracing.sampling-ratio=1.0        # dev: all; prod: e.g. 0.1
```

NOTE: Trino 444 docs named the exporter key `tracing.exporter.endpoint`;
current docs (>= 477) use `otel.exporter.endpoint`. If the pinned image
rejects one, use the other.

Trino propagates client-supplied trace ids end-to-end (coordinator -> workers
-> connectors), so a query issued from the API joins the API's trace once the
API passes `traceparent` through its Trino client (app-side work, not infra).

## Metrics — PARTIAL

Stock `trinodb/trino` exposes **no** `/metrics` endpoint; JMX only. Options,
in order of effort:

1. Accept JMX-only for dev (Trino Web UI at :8086).
2. Prometheus JMX exporter sidecar / javaagent on the coordinator, exposing
   `:9404/metrics` — then retarget the collector job `trino` in
   `../otel-collector-config.yaml` from `trino:8080/metrics` to that port.
3. OpenTelemetry javaagent with JMX metric capture:
   `-javaagent:/opt/otel/opentelemetry-javaagent.jar
    -Dotel.jmx.target.system=jvm,jetty` and
   `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317` (metrics via OTLP).

The collector's `trino` scrape job is pre-wired for option 2 and will simply
report `up == 0` until a metrics endpoint actually exists.
