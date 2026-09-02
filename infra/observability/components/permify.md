# Permify telemetry (wave W4 snippet)

Compose service: `permify` (profile `permify`, `ghcr.io/permify/permify`,
`agric-permify`, REST :3476 / gRPC :3478).

Permify has built-in OpenTelemetry tracer + meter support. Env-var form
(Permify maps `PERMIFY_<SECTION>_<KEY>` onto its config tree):

```yaml
# environment: additions for the permify compose service (integrator: W3)
PERMIFY_TRACER_ENABLED: "true"
PERMIFY_TRACER_EXPORTER: otlp
PERMIFY_TRACER_ENDPOINT: http://otel-collector:4317
PERMIFY_TRACER_INSECURE: "true"      # plaintext in-cluster; TLS in prod

PERMIFY_METER_ENABLED: "true"
PERMIFY_METER_EXPORTER: otlp
PERMIFY_METER_ENDPOINT: http://otel-collector:4317
PERMIFY_METER_INSECURE: "true"
# PERMIFY_METER_URLPATH: /v1/metrics # only for http/protobuf endpoints
```

Equivalent `permify.yaml` form, if a config file is mounted instead:

```yaml
tracer:
  exporter: otlp
  endpoint: http://otel-collector:4317
  enabled: true
  insecure: true
meter:
  exporter: otlp
  endpoint: http://otel-collector:4317
  enabled: true
  insecure: true
```

The collector's `prometheus` scrape job `permify` (:3476/metrics) is a
belt-and-braces fallback for the meter; it yields data only when the permify
version in use also exposes the prometheus surface — treat OTLP meter export
(above) as primary.
