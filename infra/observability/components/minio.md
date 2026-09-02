# MinIO telemetry (wave W4 snippet)

Compose service: `minio` (profile `lakehouse`, `minio/minio`, `agric-minio`,
:9000 S3 / :9001 console).

## Metrics — built-in Prometheus endpoints

MinIO natively exposes cluster metrics at `/minio/v2/metrics/cluster`.
Two auth modes:

1. **Public scrape (dev-friendly):** the integrator (W3) adds one env var to
   the `minio` service:

   ```yaml
   MINIO_PROMETHEUS_AUTH_TYPE: public
   ```

   The hub collector job `minio` (`minio:9000/minio/v2/metrics/cluster`) then
   works as-is. Acceptable for local dev only.

2. **Authenticated scrape (prod):** leave auth on (default `jwt`), generate a
   scrape token with `mc admin prometheus generate local`, store it in the
   Prometheus/collector secret store, and add an `authorization` block to the
   collector job — never inline the token in the config file.

## Traces — none native

MinIO does not emit OTel spans. S3 operation visibility comes from the caller
side (the API lakehouse-export code path via `@opentelemetry/instrumentation-http`
or explicit driver spans). Coverage therefore: **metrics full / traces
driver-layer only**.
