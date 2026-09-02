# Temporal server telemetry (wave W4 snippet)

Compose services: `temporal` (profile `temporal`, `temporalio/auto-setup`,
`agric-temporal`, :7233) and `temporal-ui` (:8088).

## Server metrics — Prometheus listener

`temporalio/auto-setup` only binds a Prometheus metrics endpoint when told to.
The integrator (W3) adds one env var to the `temporal` service:

```yaml
# environment: addition for the temporal compose service
PROMETHEUS_ENDPOINT: 0.0.0.0:8000
```

The hub collector already scrapes `temporal:8000/metrics` (job `temporal` in
`../otel-collector-config.yaml`). Until the env var lands, that job reports
`up == 0` — harmless.

Key series for the alert rules: `temporal_workflow_failed`,
`temporal_workflow_completed`, `service_errors_*`, `poll_success*` /
`service_requests` / `service_latency_*` (names are as emitted by the server;
verify against a live `/metrics` dump before tightening thresholds in
`../signoz/alerts/temporal-workflow-failures.json`).

## App-side tracing (NOT this wave)

Workflow/activity tracing is code-level: `@temporalio/interceptors-opentelemetry`
in `apps/api/src/workers/temporal.worker.ts` (W1) plus the API NodeSDK — spans
flow to this same collector over OTLP. Server metrics + app spans together give
full Temporal coverage.
