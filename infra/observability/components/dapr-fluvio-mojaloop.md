# Dapr / Fluvio / Mojaloop telemetry (wave W4 snippet)

These components are deployed by W3 (compose + k8s). This file is the
observability contract W3's services must meet; the hub collector's scrape
jobs reference the names below.

## Dapr sidecars

Dapr sidecars expose Prometheus metrics on **:9090/metrics** and can forward
traces via OTLP. Per-service annotations/compose env (integrator: W3):

```yaml
# compose service labels/env pattern for any daprd-enabled service
OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4317   # dapr tracing config
# dapr configuration CR/yaml:
#   spec.tracing.samplingRate: "1"
#   spec.tracing.otlp.endpointAddress: otel-collector:4317
```

Scrape job: sidecars land on per-app ports in compose; if a fixed metrics
port pattern is used (9090), add:

```yaml
- job_name: dapr-sidecar
  metrics_path: /metrics
  static_configs: [{targets: [<app-service>:9090]}]
```

Alert `dapr-sidecar-down` uses `up{job="dapr-sidecar"} == 0` — it is INERT
until this job exists (documented in the alert file).

## Fluvio

Honest status: **PARTIAL.** Fluvio's streaming controller (SC) has limited
Prometheus support; community manifests conventionally use SC metrics on
:30010. The collector job `fluvio-sc` (`fluvio-sc:30010/metrics`) is pre-wired
but UNVERIFIED against W3's deployment — confirm service name + port. SPU
metrics are best-effort; platform event-flow visibility primarily comes from
the API's fluvio driver spans (`EVENT_BUS_DRIVER=fluvio`, W2).

## Mojaloop

Mojaloop core services (account-lookup-service, quoting-service,
ml-api-adapter, central-ledger) expose Prometheus `/metrics` on their ops
ports. The collector job `mojaloop` targets placeholder names:

```yaml
targets: [account-lookup-service:4002, quoting-service:3002, ml-api-adapter:3000]
```

UPDATE these to W3's actual compose service names/ports. The API-side FSPIOP
adapter (`mojaloop.driver.ts`, W2) emits spans + failure counters
(`mojaloop_transfers_failed_total`) which drive the
`mojaloop-transfer-failures` alert — that alert works off API metrics even if
the server scrapes never materialize.
