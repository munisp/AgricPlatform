# AgricPlatform Observability (stage 25)

Collector-centric telemetry: **one hub OpenTelemetry Collector** receives or
pulls everything, forwards to **SigNoz** (traces/metrics/logs UI, alert
rules, notification channels) and re-exposes metrics on **:9464** so the
existing Prometheus + Grafana + `alerts.yml` keep working unchanged.

## Architecture

```
                     ┌─────────────────── push (OTLP) ───────────────────┐
 api / temporal-worker (NodeSDK, OTLP gRPC :4317)                         │
 keycloak (KC_TRACING_* → :4317)          permify (tracer/meter → :4317)  │
 apisix (opentelemetry plugin → :4318)    trino (tracing.enabled → :4317) │
 python/go/rust sidecars, dapr, sedona agent                             ▼
                                                        ┌─────────────────────────┐
 postgres ── postgresql receiver ──▶                    │  HUB otel-collector     │
 redis ────── redis receiver ──────▶  receivers →       │  (otel-collector-       │
 redpanda ─── kafkametrics ───────▶  memory_limiter →   │   config.yaml)          │
 temporal/permify/trino/minio/ ──▶  attributes(env) →   │                         │
 openappsec/apisix/event-gw/     filter(health) →       │                         │
 geo-compute/mojaloop/fluvio     resource → batch       │                         │
   ── prometheus scrapes ──────▶                        │                         │
 openappsec logs ── filelog ────▶                       │                         │
                                                        └───────┬────────┬────────┘
                                              OTLP :4317        │        │ /metrics :9464
                                                                ▼        ▼
                                              ┌──────────────────────┐  existing
                                              │ signoz-otel-collector│  Prometheus
                                              │ → clickhouse         │  (prometheus.yml
                                              │ → query-service/     │   job otel-collector)
                                              │   frontend/          │
                                              │   alertmanager       │
                                              └──────────────────────┘
```

## Per-component coverage

| Component | Traces | Metrics | Logs | Mode | Status |
|---|---|---|---|---|---|
| api / temporal-worker (NestJS) | OTLP (25.1 SDK) | OTLP + existing `/api/v1/metrics` pull | pino trace-id correlation (25.1) | native | full |
| keycloak 26.7 | `KC_TRACING_*` → :4317 (`infra/keycloak/otel.env`) | `KC_METRICS_ENABLED` (optional scrape) | — | native | full |
| apisix | `opentelemetry` plugin → :4318 (`infra/apisix/`) | `prometheus` plugin :9091, scraped | — | native | full |
| postgres | — (queries traced via pg instrumentation in API) | `postgresql` receiver | — | native receiver | full |
| redis | — (via ioredis instrumentation) | `redis` receiver | — | native receiver | full |
| redpanda (kafka API) | — (via kafkajs instrumentation) | `kafkametrics` receiver | — | native receiver | full |
| temporal server | app spans via TS interceptors (W1) | prometheus scrape :8000 (needs `PROMETHEUS_ENDPOINT`) | — | native server metrics | full (metrics need 1 env var) |
| permify | OTel tracer → OTLP (env in `components/permify.md`) | OTel meter → OTLP; scrape fallback :3476 | — | native | full |
| trino | `tracing.enabled` + `otel.exporter.endpoint` → :4317 | **PARTIAL**: no native `/metrics`; JMX exporter or OTel javaagent needed | — | native traces / partial metrics | partial (metrics) |
| minio | — (caller-side spans) | `/minio/v2/metrics/cluster` scraped (needs `MINIO_PROMETHEUS_AUTH_TYPE=public` or bearer) | — | native metrics | full (metrics) |
| opensearch | — (driver-layer spans) | **PARTIAL**: prometheus-exporter plugin not installed by default | — | plugin | partial |
| tigerbeetle | **NONE native** — driver spans only (W1) | **NONE native** — driver counters only | — | driver-layer | partial (by design; scrape nothing) |
| mojaloop | driver spans (W2) | driver counters + server `/metrics` scrape (placeholder targets) | — | driver + scrape | partial (server scrape unverified) |
| openappsec | none | scrape :8002 **UNVERIFIED port** | filelog receiver (needs volume mount) | scrape + filelog | partial |
| sedona/spark | OTel javaagent on spark-submit (JVM/http only; no per-stage spans) | same agent | — | javaagent | partial (batch only) |
| dapr | sidecar OTLP tracing config | sidecar :9090 scrape (job template) | — | native sidecar | pending W3 deployment |
| fluvio | API driver spans (W2) | **PARTIAL**: SC scrape :30010 unverified | — | driver + best-effort scrape | partial |
| event-gw (Go) | OTLP env (W5 `otelhttp`) | existing `/metrics` :8090 scraped | — | native after W5 | full after W5 |
| geo-compute (Rust) | OTLP env (W5 tracing-opentelemetry) | `/metrics` after W5; scrape job pre-wired | — | native after W5 | full after W5 |
| flood-ml / crop-ml (Python) | OTLP env (W5 FastAPI instrumentor) | OTLP metrics | — | native after W5 | full after W5 |

"PARTIAL" ceilings are honest: no amount of infra config gives TigerBeetle
spans or Spark per-stage traces — those layers simply don't emit them.

## Tenant attribution model

`tenant.id` flows in two places:

1. **In-app (authoritative):** the stage-25.1 `TenantAttributionInterceptor`
   reads `request.user.id` / `request.partner.clientId` and stamps
   `tenant.id` on every span/metric. Driver spans (W1/W2) inherit it via
   AsyncLocalStorage context.
2. **Edge (coarse):** the APISIX `opentelemetry` plugin sets a static
   `tenant.id: unknown` resource attribute — APISIX standalone mode cannot
   resolve tenants per request; the app value wins downstream. A custom
   APISIX plugin can later overwrite it from a header/claim without touching
   the collector.

In the hub collector, `resource_to_telemetry_conversion` on the prometheus
exporter turns `tenant.id` into a `tenant_id` label, and the optional
`groupbyattrs/tenant` pipeline emits per-tenant series. **Cardinality
warning:** keep tenant series opt-in (bounded tenant counts); prefer SigNoz
query-time grouping otherwise. The `tenant-error-spike` alert is the
matcher example.

## Alert catalog

SigNoz rules live in `signoz/alerts/*.json` (import instructions:
`signoz/README.md`). Existing Prometheus rules in `alerts.yml` are untouched.

| File | Fires when | Severity | Source series |
|---|---|---|---|
| api-error-rate | 5xx ratio > 2% over 5m | critical | `http_requests_total` |
| p95-latency-per-service | p95 > 2s per service, 5m | warning | `http_request_duration_seconds_bucket` |
| escrow-payout-failures | any payout failure in 10m | critical | `agric_escrow_payout_failed_total` (name TBC) |
| tigerbeetle-operation-errors | any TB op error in 5m | critical | `tigerbeetle_operations_total{result="error"}` (W1 contract) |
| temporal-workflow-failures | any workflow failure in 10m | warning | `temporal_workflow_failed` |
| dapr-sidecar-down | `up{job="dapr-sidecar"} == 0` | critical | scrape `up` (inert until W3) |
| postgres-connections | conns > 80% of max, 5m | warning | `postgresql_backends` / `postgresql_connection_max` |
| redis-memory | used > 85% of maxmemory, 5m | warning | `redis_memory_used` / `redis_memory_max` |
| tenant-error-spike | per-`tenant_id` 5xx > 0.5/s, 5m | warning | `http_requests_total` + `tenant_id` label |
| mojaloop-transfer-failures | any transfer failure in 10m | critical | `mojaloop_transfers_failed_total` (W2 contract) |

## Running it

Compose snippets (paste-ready for the integrator, W3) are below. Then:

```sh
docker compose --profile observability up -d
# SigNoz UI:    http://localhost:3301   (frontend)
# Collector:    OTLP :4317/:4318, prometheus re-export :9464, health :13133
```

Set notification channels in SigNoz (Settings → Notification Channels) from
`signoz/channels/*.json` — all values are labelled dev placeholders. Import
alert rules from `signoz/alerts/*.json` (`signoz/README.md`).

### Compose snippets for the integrator (W3)

```yaml
  # ---- Observability hub (profile: observability) ----
  otel-collector:
    profiles: ["observability"]
    image: otel/opentelemetry-collector-contrib:0.113.0
    container_name: agric-otel-collector
    command: ["--config=/etc/otelcol/otel-collector-config.yaml"]
    environment:
      POSTGRES_USER: agric
      POSTGRES_PASSWORD: agric            # dev placeholder — secret store in prod
      DEPLOYMENT_ENVIRONMENT: ${DEPLOYMENT_ENVIRONMENT:-development}
    volumes:
      - ./observability/otel-collector-config.yaml:/etc/otelcol/otel-collector-config.yaml:ro
      - appsec-logs:/var/log/openappsec/nano_agent:ro   # openappsec filelog
    ports:
      - "4317:4317"    # OTLP gRPC
      - "4318:4318"    # OTLP HTTP
      - "9464:9464"    # prometheus re-export
      - "13133:13133"  # health_check extension
    depends_on:
      - signoz-otel-collector
    restart: unless-stopped
    networks: [agric]

  # ---- SigNoz stack (profile: observability) ----
  signoz-zookeeper:
    profiles: ["observability"]
    image: bitnami/zookeeper:3.7.1
    container_name: agric-signoz-zookeeper
    environment:
      ZOO_SERVER_ID: "1"
      ALLOW_ANONYMOUS_LOGIN: "yes"
      ZOO_AUTOPURGE_INTERVAL: "1"
    volumes: [signoz-zookeeper-data:/bitnami]
    networks: [agric]

  signoz-clickhouse:
    profiles: ["observability"]
    image: clickhouse/clickhouse-server:24.1.2-alpine
    container_name: agric-signoz-clickhouse
    depends_on: [signoz-zookeeper]
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "localhost:8123/ping"]
      interval: 30s
      timeout: 5s
      retries: 3
    volumes: [signoz-clickhouse-data:/var/lib/clickhouse]
    networks: [agric]

  signoz-otel-collector-migrator:
    profiles: ["observability"]
    image: signoz/signoz-schema-migrator:0.111.13
    container_name: agric-signoz-migrator
    command: ["--dsn=tcp://signoz-clickhouse:9000"]
    depends_on:
      signoz-clickhouse: {condition: service_healthy}
    networks: [agric]

  signoz-otel-collector:
    profiles: ["observability"]
    image: signoz/signoz-otel-collector:0.111.13
    container_name: agric-signoz-otel-collector
    # default image config receives OTLP on 4317/4318 and writes clickhouse
    command: ["--config=/etc/otel-collector-config.yaml", "--feature-gates=-pkg.translator.prometheus.NormalizeName"]
    environment:
      OTEL_RESOURCE_ATTRIBUTES: host.name=agric-signoz,os.type=linux
      LOW_CARDINAL_EXCEPTION_GROUPING: "false"
    depends_on:
      signoz-clickhouse: {condition: service_healthy}
      signoz-otel-collector-migrator: {condition: service_completed_successfully}
    restart: on-failure
    networks: [agric]

  signoz-query-service:
    profiles: ["observability"]
    image: signoz/query-service:0.55.0
    container_name: agric-signoz-query-service
    command: ["-config=/root/config/prometheus.yml"]
    volumes:
      - signoz-data:/var/lib/signoz
    environment:
      ClickHouseUrl: tcp://signoz-clickhouse:9000/?database=signoz_traces
      ALERTMANAGER_API_PREFIX: http://signoz-alertmanager:9093/api/
      SIGNOZ_LOCAL_DB_PATH: /var/lib/signoz/signoz.db
      STORAGE: clickhouse
      GODEBUG: netdns=go
      TELEMETRY_ENABLED: "true"
      DEPLOYMENT_TYPE: docker-standalone
      # SMTP for email notification channels (dev placeholders):
      SMTP_ENABLED: "false"
      # SMTP_HOST: smtp.example.com
      # SMTP_PORT: "587"
      # SMTP_FROM: signoz@agric-platform.example.com
      # SMTP_AUTH_USERNAME: REPLACE_WITH_SMTP_USERNAME
      # SMTP_AUTH_PASSWORD: REPLACE_WITH_SMTP_PASSWORD
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "localhost:8080/api/v1/health"]
      interval: 30s
      timeout: 5s
      retries: 3
    depends_on:
      signoz-clickhouse: {condition: service_healthy}
      signoz-otel-collector-migrator: {condition: service_completed_successfully}
    restart: on-failure
    networks: [agric]

  signoz-alertmanager:
    profiles: ["observability"]
    image: signoz/alertmanager:0.23.5
    container_name: agric-signoz-alertmanager
    command:
      - --queryService.url=http://signoz-query-service:8085
      - --storage.path=/data
    volumes: [signoz-alertmanager-data:/data]
    depends_on:
      signoz-query-service: {condition: service_healthy}
    restart: on-failure
    networks: [agric]

  signoz-frontend:
    profiles: ["observability"]
    image: signoz/frontend:0.55.0
    container_name: agric-signoz-frontend
    ports: ["3301:3301"]
    depends_on:
      - signoz-alertmanager
      - signoz-query-service
    restart: on-failure
    networks: [agric]

# volumes to add to the top-level volumes: block:
#   signoz-zookeeper-data:
#   signoz-clickhouse-data:
#   signoz-data:
#   signoz-alertmanager-data:
```

Integrator checklist beyond these snippets:
1. `temporal` service: add `PROMETHEUS_ENDPOINT: 0.0.0.0:8000` env.
2. `minio` service: add `MINIO_PROMETHEUS_AUTH_TYPE: public` (dev) or wire a bearer token.
3. `keycloak` service: paste `infra/keycloak/otel.env` contents.
4. `permify` service: paste env from `components/permify.md`.
5. `geo-compute`/`event-gw`/`flood-ml`/`crop-ml`: OTLP env from `components/polyglot-services.md`.
6. `trino`: mount config.properties additions from `components/trino.md`.
7. Every OTLP-producing service must `depends_on: [otel-collector]` (soft) or tolerate export retry.

## Validation

- All YAML parsed with PyYAML; all JSON parsed with `json.load` (wave W4 run).
- `otelcol validate` was NOT run (no collector binary/docker in the sandbox);
  structural self-check: every receiver/processor/exporter/extension referenced
  in `service.pipelines` is defined, and component names match the contrib
  0.113.0 distribution.
- Metric-name placeholders in SigNoz rules (escrow/tigerbeetle/mojaloop/
  temporal) are contracts to verify against W1/W2 emitters and a live
  temporal `/metrics` dump — they are annotated inside each rule file.
