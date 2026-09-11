# OpenSearch telemetry (wave W4 snippet)

Compose service: `opensearch` (profile `opensearch`, `opensearchproject/opensearch:2`,
`agric-opensearch`, :9200, security plugin enabled in dev).

## Metrics — prometheus-exporter plugin

Install the community prometheus-exporter plugin into the image (custom
Dockerfile or an init step; NOT mounted as config):

```dockerfile
FROM opensearchproject/opensearch:2
RUN bin/opensearch-plugin install --batch \
  https://github.com/aparo/opensearch-prometheus-exporter/releases/download/2.15.0.0/prometheus-exporter-2.15.0.0.zip
# NOTE: pin the plugin version to the exact opensearch version in use.
```

It then serves `GET /_prometheus/metrics` (TLS + basic auth while the security
plugin is on). Add a collector scrape job when adopted:

```yaml
- job_name: opensearch
  scheme: https
  metrics_path: /_prometheus/metrics
  tls_config: {insecure_skip_verify: true}   # demo certs only!
  basic_auth: {username: admin, password: ${OPENSEARCH_ADMIN_PASSWORD}}
  static_configs: [{targets: [opensearch:9200]}]
```

(Deliberately NOT pre-wired in `../otel-collector-config.yaml`: the plugin is
not installed by default and the scrape would 404 against the secured node.)

## Traces — Data Prepper (optional, trace-analytics)

OpenSearch itself does not emit OTel spans. If request-level trace storage in
OpenSearch is wanted, run Data Prepper with an OTel trace source fed by the
hub collector (add `otlp/trace-analytics` exporter to the hub):

```yaml
# data-prepper pipeline.yaml (deploy as a separate service if adopted)
entry-pipeline:
  source:
    otel_trace_source:
      ssl: false
  sink:
    - opensearch:
        hosts: ["https://opensearch:9200"]
        username: admin
        password: ${OPENSEARCH_ADMIN_PASSWORD}
        insecure: true                  # demo certs only
        index_type: trace-analytics-raw
service-map-pipeline:
  source:
    pipeline: {name: entry-pipeline}
  sink:
    - opensearch:
        hosts: ["https://opensearch:9200"]
        username: admin
        password: ${OPENSEARCH_ADMIN_PASSWORD}
        insecure: true
        index_type: trace-analytics-service-map
```

Default posture: search spans/metrics come from the API's own
`opensearch.driver.ts` instrumentation (W1/W2) — this file's pipeline is an
optional enhancement, marked PARTIAL in the coverage table.
