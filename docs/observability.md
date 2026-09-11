# Observability — OpenTelemetry across the platform

Every service on the platform emits traces, metrics, or logs through
**OpenTelemetry (OTel)**, and every signal can carry a **`tenant.id`**
attribute so a cooperative, programme, or partner can be isolated in
dashboards and alerts.

This document is the developer guide. Operator-level detail (collector
pipeline, per-component receiver configuration, alert catalog) lives in
[`infra/observability/README.md`](../infra/observability/README.md);
environment variables are catalogued in
[`infra/environments.md`](../infra/environments.md).

## Architecture in one paragraph

One **hub OTel Collector** (`otel-collector`, compose profile
`observability`) receives OTLP pushes from applications and scrapes/pulls
from infrastructure (PostgreSQL, Redis, Redpanda, Temporal, MinIO,
OpenAppSec, …). It forwards everything to **SigNoz** — the open-source
traces/metrics/logs UI with alert rules and notification channels — and
re-exposes all metrics on **`:9464`** so the pre-existing Prometheus +
Grafana + `alerts.yml` stack keeps working unchanged.

```
apps ──OTLP──▶ ┌──────────────┐ ──OTLP──▶ SigNoz (UI + alerts + channels)
infra ─pull──▶ │ otel-collector│
               └──────┬───────┘
                      └── /metrics :9464 ──▶ existing Prometheus/Grafana
```

## Enabling it

Telemetry is **off by default and fails safe**: a missing or dead collector
never breaks a request, a boot, or a test. There are no throw paths in the
telemetry initialisation and no boot-fatal assertions on OTel env vars.

| Variable | Default | Meaning |
|---|---|---|
| `OTEL_ENABLED` | `false` | Master switch. `false` = near-free no-op everywhere. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP HTTP endpoint of the hub collector. |
| `OTEL_SERVICE_NAME` | per-service | Resource `service.name` (e.g. `agric-api`). |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` non-prod, `0.1` prod | Trace sampling ratio (parent-based). |

Component-specific variables (Keycloak `KC_TRACING_*`, Permify tracer
exporter, APISIX plugin config, Trino `tracing.enabled`, polyglot service
env) are documented per component in `infra/observability/components/*.md`.

```sh
docker compose -f infra/docker-compose.yml --profile observability up -d
# SigNoz UI: http://localhost:3301 · OTLP :4317/:4318 · prom re-export :9464
```

## Tenant attribution

`tenant.id` is stamped authoritatively **in the API**: the global
`TenantAttributionInterceptor` resolves the tenant from the authenticated
principal — partner `clientId` (`cooperative:*` / `programme:*`), then
`user:<id>`, falling back to `anonymous` — via AsyncLocalStorage
(`tenant-context.ts`). Every span, metric, and correlated log line created
downstream (database, event bus, payments, workflows) inherits it.

At the edge, the APISIX `opentelemetry` plugin sets a static placeholder;
the in-app value wins downstream. In the collector,
`resource_to_telemetry_conversion` turns `tenant.id` into a `tenant_id`
Prometheus label — keep per-tenant series **opt-in** (cardinality); prefer
SigNoz query-time grouping for unbounded tenant counts.

## Using it in API code

The global `TelemetryModule` provides a no-op-safe `TelemetryService`:

```ts
import { TelemetryService } from '../common/telemetry/telemetry.service';

// spans
const result = await this.telemetry.withSpan('escrow.payout', async () => { ... });

// metrics
this.telemetry.increment('agric_escrow_payout_failed_total', { reason: 'timeout' });
this.telemetry.record('agric_loan_disbursement_seconds', elapsed);
```

Rules that keep telemetry trustworthy:

- **Never throw from telemetry.** If a span/metric call can fail, the SDK
  must swallow it — business flow always wins.
- **No secrets or account identifiers in attributes.** Driver spans use
  operation names and counts, never TigerBeetle account IDs, NINs, or
  amounts beyond what the domain already logs.
- **Strip query strings** on HTTP client spans (tokens ride query params).
- Initialise via `telemetry.boot.ts` as the **first import** in `main.ts`
  (ESM hoisting makes side-effect order matter).

The Temporal worker boots the same SDK and adds
`@temporalio/interceptors-opentelemetry` so workflow/activity spans join the
request trace.

## Coverage matrix

Full = native or receiver-based traces **and** metrics. Partial ceilings are
honest limitations of the component itself, not missing configuration.

| Component | Traces | Metrics | Mode | Status |
|---|---|---|---|---|
| api / temporal-worker (NestJS) | OTLP SDK | OTLP + `/api/v1/metrics` | native | full |
| postgres | pg auto-instrumentation | `postgresql` receiver | native receiver | full |
| redis | ioredis instrumentation | `redis` receiver | native receiver | full |
| redpanda (Kafka API) | kafkajs instrumentation | `kafkametrics` receiver | native receiver | full |
| temporal server | TS interceptors | prometheus :8000 (`PROMETHEUS_ENDPOINT`) | native | full (1 env var) |
| keycloak 26.7 | `KC_TRACING_*` | `KC_METRICS_ENABLED` | native | full |
| permify | OTel tracer → OTLP | OTel meter → OTLP | native | full |
| apisix | `opentelemetry` plugin | `prometheus` plugin :9091 | native | full |
| dapr | sidecar OTLP config | sidecar :9090 scrape | native sidecar | full |
| event-gw (Go) | `otelhttp` → OTLP | `/metrics` :8090 | native | full |
| geo-compute (Rust) | tracing-opentelemetry | `/metrics` :8200 | native | full |
| flood-ml / crop-ml (Python) | FastAPI instrumentor | OTLP metrics | native | full |
| trino | `tracing.enabled` | needs JMX exporter/javaagent | native traces | partial (metrics) |
| minio | caller-side spans | `/minio/v2/metrics/cluster` | native metrics | full (metrics) |
| opensearch | driver spans | prometheus-exporter plugin not default | plugin | partial |
| **tigerbeetle** | driver spans only | driver counters only | driver-layer | partial — **no native surface exists** |
| **mojaloop** | driver spans (live FSPIOP driver) | driver counters + server scrape | driver + scrape | integration-grade (Helm 17.2.0 / TTK) |
| **fluvio** | driver spans | SC scrape :30010 (tentative) | driver + scrape | partial |
| **openappsec** | none | scrape :8002 (unverified) + filelog | scrape + filelog | partial |
| **sedona/spark** | OTel javaagent (JVM/http only) | same agent | javaagent | partial (batch only) |
| **geolibre** | n/a (static portal) | n/a | container | stack re-implemented in `apps/web` (see `docs/geospatial.md`) |

## Alerts and notifications

SigNoz alert rules: `infra/observability/signoz/alerts/*.json` — includes
API error rate, p95 latency, **escrow-payout-failures**,
**tigerbeetle-operation-errors**, temporal-workflow-failures,
**dapr-sidecar-down**, postgres/redis capacity, **tenant-error-spike**
(per-`tenant_id`), and **mojaloop-transfer-failures**. Import via
`infra/observability/signoz/README.md`. Notification channels
(`signoz/channels/*.json`: Slack, generic webhook, email) ship with
`REPLACE_WITH_*` placeholders — no real endpoints or secrets are committed.

Metric names referenced by the new alerts (escrow / tigerbeetle / mojaloop /
temporal) are **emitter contracts to confirm against live traffic** before
relying on them in production; each rule file is annotated accordingly.

## Known ceilings (do not "fix" silently)

- TigerBeetle emits no native telemetry; driver-layer spans/counters are the
  designed ceiling.
- OpenAppSec's metrics port and Sedona per-stage tracing are unverified /
  unsupported upstream; both are documented as partial.
- `otelcol validate` has not been run in CI yet; the collector config is
  structurally self-checked and YAML-verified only.
