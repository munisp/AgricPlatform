# Fluvio on Kubernetes (agric-platform)

Streaming cluster for the platform, mirroring the compose profile `fluvio`
(SC :9003, SPU public :9010 / private :9011, pinned `infinyon/fluvio:v0.18.1`).

## Official chart location

Fluvio does not publish to a Helm HTTP repository; the official charts ship
with the source and as release assets of the pinned platform release:

- Source: `k8-util/helm/fluvio-sys` and `k8-util/helm/fluvio-app` in
  <https://github.com/fluvio-community/fluvio> (tag `v0.18.1`).
- Release assets: `fluvio-chart-sys.tgz` / `fluvio-chart-app.tgz` attached to
  <https://github.com/fluvio-community/fluvio/releases/tag/v0.18.1>.

The officially supported install path is the Fluvio CLI, which drives those
charts:

```bash
# CLI v0.18.1 (x86_64 linux): https://github.com/fluvio-community/fluvio/releases/tag/v0.18.1
fluvio cluster start --k8 --namespace agric-platform
```

## Helm path (equivalent)

```bash
TAG=v0.18.1
curl -sLO "https://github.com/fluvio-community/fluvio/releases/download/${TAG}/fluvio-chart-sys.tgz"
curl -sLO "https://github.com/fluvio-community/fluvio/releases/download/${TAG}/fluvio-chart-app.tgz"

# 1. CRDs / system chart (cluster-scoped, once per cluster)
helm upgrade --install fluvio-sys fluvio-chart-sys.tgz

# 2. App chart with the platform overrides in this directory
helm upgrade --install fluvio fluvio-chart-app.tgz \
  --namespace agric-platform \
  --values infra/k8s/fluvio/values.yaml \
  --wait
```

`values.yaml` here pins `image.tag: v0.18.1` and a single-SPU dev shape.
Verify any additional keys against the pinned chart's own `values.yaml`
(`k8-util/helm/fluvio-app/values.yaml` at tag v0.18.1) before extending —
only the keys above are intentionally overridden.

## Observability

- SC/SPU are Rust services logging to stdout (`RUST_LOG`) — collect via the
  cluster's stdout pipeline (observability overlay).
- Fluvio exposes Prometheus-format metrics from the SC/SPU (platform metric
  endpoint since 0.10.x); the exact per-version scrape path/port should be
  confirmed against the pinned chart's Service definitions before adding a
  scrape job — see the note handed to the observability coder in W3's report.
