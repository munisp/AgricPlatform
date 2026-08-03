# Observability runbook (API)

Scope: `apps/api` — structured logging, Prometheus metrics, error tracking,
health/readiness, and the tamper-evident audit trail (implementation plan:
`docs/roadmap/observability-a11y-plan.md`, workstream A).

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/metrics` | Prometheus scrape endpoint (default metrics + app series). Access-controlled in-app (Wave OPS): `Authorization: Bearer $METRICS_TOKEN` scrape credential OR an admin identity (OIDC bearer; `x-user-id` only where dev auth is allowed). Anonymous scrapes are 401 in production, allowed outside production for local Prometheus parity. Defense in depth: still restrict at the edge/ingress (`NetworkPolicy`, internal scrape only). |
| `GET /api/v1/health` | Overall health banner. |
| `GET /api/v1/health/live` | Liveness probe. |
| `GET /api/v1/health/ready` | Readiness: integrations + dependency registry. `degraded` when a **configured** dependency is down; `skipped` (unconfigured) never degrades. |
| `GET /api/v1/admin/audit-log/verify` | Admin-gated hash-chain verification of the audit log: `{ valid, brokenAt? }`. |

## Metrics

Default Node.js/process metrics are collected with the label
`service="agric-api"`. Application series:

| Metric | Labels | Meaning |
| --- | --- | --- |
| `http_requests_total` | `method`, `route`, `status` | Request count. `route` is the parameterized Nest route (`/api/v1/orders/:id/status`) — never the concrete URL; unmatched requests use `unmatched`. |
| `http_request_duration_seconds` | `method`, `route`, `status` | Request latency histogram. |
| `agric_otp_requests_total` | `channel` | OTP challenges requested (`sms`). |
| `agric_otp_verifications_total` | `result` | `success` / `invalid` / `locked`. |
| `agric_orders_created_total` | `escrow` | Orders placed, split by escrow requirement (`true`/`false`). |
| `agric_payments_total` | `event` | `initiated` (order → `deposit_paid`), `confirmed` (→ `completed`), `webhook_received`, `webhook_duplicate`. |
| `agric_idempotent_replays_total` | — | Idempotency-key replays served from cache. |
| `agric_errors_5xx_total` | — | 5xx responses from the exception filter. |
| `agric_outbox_backlog_records` | `state` | Outbox rows pending vs dead-lettered (scrape-time gauge, Wave OPS). |
| `agric_outbox_oldest_pending_age_seconds` | — | Age of the oldest unpublished outbox row. |
| `agric_notifications_queued` | — | Notifications waiting for delivery. |
| `agric_notification_dlq_depth` | — | Delivery-log entries dead-lettered after retries. |
| `agric_escrow_locked_amount_kobo` | `status` | Escrow funds still locked (`held`/`disputed`/`releasing`/`refunding`). |

The backlog/escrow gauges are computed at scrape time from the repositories;
a failing collector logs a warning and leaves the previous reading rather
than breaking the scrape. Scrape config, SLO alerts and the Grafana
dashboard live in `infra/observability/` (`prometheus.yml`, `alerts.yml`,
`grafana/dashboards/platform.json`); alert response steps are in
[ops.md](ops.md).

## Logging

JSON via pino (`nestjs-pino` + `pino-http`). Every request carries a
`requestId`: an inbound `x-request-id` header is honored and always echoed
back on the response, otherwise a UUID is generated. Level: `LOG_LEVEL` >
`info` (production) > `debug` (otherwise). `LOG_PRETTY=1` enables the
pino-pretty transport for local development only (worker-thread transport —
never enable in production). Successful `/api/v1/health*` probes are not
request-logged.

### Redaction policy (never logged)

- Headers: `authorization`, `cookie`, `x-api-key`.
- Bodies/responses: `code`, `devCode`, `token`, `user.phone`.
- Phone numbers are masked (`0803****000`) in request serializers.
- Financial payloads: log IDs and status transitions only, never full
  webhook payloads (webhook controllers log/audit the provider + event, not
  the body).

## Error tracking (Sentry)

Fully disabled unless `SENTRY_DSN` is set — the SDK is loaded via dynamic
import only when a DSN exists, so there is no overhead when off.
`beforeSend` scrubs auth headers, phone numbers, and OTP/token fields.
Only 5xx exceptions are captured (`capture5xx`); 4xx is client noise.

## Alert starting points (Prometheus/Alertmanager)

```promql
# API 5xx spike — page
rate(agric_errors_5xx_total[5m]) > 0.1

# Error ratio — page at >5% over 10m
sum(rate(http_requests_total{status=~"5.."}[10m]))
  / sum(rate(http_requests_total[10m])) > 0.05

# Latency — warn at p95 > 2s (low-bandwidth API budget)
histogram_quantile(0.95,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route)) > 2

# OTP abuse — lockouts climbing
rate(agric_otp_verifications_total{result="locked"}[15m]) > 0.05

# Idempotent replay storms (client retry loops)
rate(agric_idempotent_replays_total[10m]) > 1

# Readiness flapping
changes(agric_readiness_status[10m])  # (export readiness via a blackbox probe)
```

## Dashboard suggestions (Grafana)

1. **Traffic**: `rate(http_requests_total[5m])` by `route`; 4xx/5xx ratios.
2. **Latency heatmap**: `http_request_duration_seconds_bucket` per route.
3. **Auth health**: OTP requests vs verification results (funnel), lockouts.
4. **Marketplace**: orders created (escrow split), payments
   initiated/confirmed, webhook received vs duplicate.
5. **Reliability**: `agric_errors_5xx_total` rate, idempotent replays,
   readiness probe status over time.
6. **Audit**: periodic `audit-log/verify` result (blackbox/synthetic check).

## Audit trail

Every audit record carries `prevHash`/`hash`
(`sha256(canonicalJSON(event) + prevHash)`, genesis = 64 zeros) and an
optional `requestId`. Verify via `GET /api/v1/admin/audit-log/verify`
(admin role) — `brokenAt` identifies the first tampered/unlinked record.
PostgreSQL deployments need migration `infra/postgres/002_audit_hash_chain.sql`
(applied by `npm run migrate -w @agric-platform/api`).

## External verification (not covered in this environment)

- Prometheus/Alertmanager/Grafana deployment itself (configs are provided
  in `infra/observability/` but no live Prometheus has scraped this API
  from this repository).
- Kubernetes `ServiceMonitor` wiring (if using the prometheus-operator).
- Sentry delivery with a real DSN; confirm `beforeSend` scrubbing on real events.
