# TigerBeetle telemetry (wave W4 snippet)

Compose services: `tigerbeetle-init` + `tigerbeetle` (profile `tigerbeetle`,
`ghcr.io/tigerbeetle/tigerbeetle`, :3000).

Honest status: **NO native telemetry — scrape nothing.**

TigerBeetle deliberately ships without a metrics endpoint, tracing hooks, or
structured log export (design: minimal single-binary consensus engine; observe
via the client). There is nothing for the collector to pull.

## Coverage model — driver layer

1. **API driver spans/metrics (primary, W1):** every `postTransfer` / `status`
   call through `tigerbeetle.driver.ts` emits spans (`ledger.operation`,
   `ledger.result`, `tenant.id` attrs) and counters (`tigerbeetle_operations_total{result}`).
   The SigNoz alert `tigerbeetle-operation-errors` consumes those series.
2. **Optional Rust shim (stretch, not delivered):** a sidecar can poll
   TigerBeetle replica state and re-emit as OTel metrics; no such shim exists
   in this repo and the value is marginal for a single-replica dev cluster.
3. **Liveness:** the collector does not probe TigerBeetle; the API driver's
   circuit breaker (`*_CIRCUIT_THRESHOLD=3`) plus `status()` spans surface
   outages instead. A docker healthcheck on the container (integrator's call)
   is the cheap complement.

If TigerBeetle later ships an official metrics surface, add a scrape job to
`../otel-collector-config.yaml` — none is present by design today.
