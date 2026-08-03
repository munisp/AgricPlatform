# event-gw — webhook/event ingestion edge (Go, stdlib-only)

High-throughput edge service that ingests **external provider webhooks**
(weather alerts, payment callbacks, satellite-imagery notifications, partner
API events), verifies their authenticity, and fans them out to the
AgricPlatform API's internal event ingress
(`POST {EVENTGW_API_INGRESS_URL}`, e.g. the NestJS internal events endpoint
fronting the Kafka EventBus). This service is the **verified edge only** — it
does not own the bus.

**Go standard library only.** `go.mod` has zero `require` directives; the
build needs no module downloads.

## Fail-closed semantics (hard rule)

| Mode | Behaviour |
| --- | --- |
| `EVENTGW_MODE=stub` (**default**) | Signature verification is **skipped** and a loud startup warning says so. Events are still validated for shape (non-empty JSON object), replay-checked, and fanned out. For development and CI only. |
| `EVENTGW_MODE=live` | Every webhook must carry a valid HMAC-SHA256 signature and a fresh timestamp. A provider missing its `EVENTGW_SECRET_<NAME>` is a **FATAL startup misconfiguration**: that provider's route answers **503** and the process stays up for correctly configured providers. Unverified webhooks are **never** silently accepted. |

Verification pipeline in live mode (any failure → 401/503 + `rejected`
metric, never fanned out):

1. Timestamp header present and within ±300 s (`EVENTGW_MAX_SKEW_SECONDS`)
   of server time. Unix seconds or RFC3339. Boundary: 299 s ok, 301 s
   rejected (300 s exactly is accepted).
2. HMAC-SHA256 over the **raw body**, compared in constant time
   (`crypto/hmac` + `hmac.Equal`) against the signature header, decoded per
   provider as hex (optional `sha256=` prefix tolerated) or base64
   (`EVENTGW_SIG_ENCODING_<NAME>`).
3. Replay cache: an in-memory map (mutex-guarded, TTL eviction goroutine)
   keyed on provider+timestamp+signature rejects duplicate deliveries with
   **409** for `EVENTGW_REPLAY_TTL_SECONDS` (default 600 s). In stub mode the
   key falls back to a body hash — two distinct-but-identical payloads inside
   the window collapse to a replay there, a documented stub-mode limitation.

## Endpoints

| Route | Purpose |
| --- | --- |
| `POST /webhooks/{provider}` | Ingest one webhook. `202` once durably accepted (`"delivery":"delivered"` or `"spooled"`), `400` bad shape, `401` bad signature/timestamp, `404` unknown provider, `409` replay, `503` live-mode provider without secret. |
| `GET /healthz` | Liveness: mode, uptime, known provider count. Always 200. |
| `GET /readyz` | Readiness detail: circuit-breaker state + spool backlog. `200` ready, `503` degraded while the breaker is open (the spool still accepts). |
| `GET /metrics` | Prometheus text format, hand-rolled: `eventgw_webhooks_received_total`, `eventgw_webhooks_verified_total`, `eventgw_webhooks_rejected_total`, `eventgw_events_fanned_total`, `eventgw_events_deadlettered_total` (all `{provider=...}`), plus gauges `eventgw_spool_backlog`, `eventgw_breaker_open`, `eventgw_mode{mode=...}`. Verified stays 0 in stub mode — honest by construction. |

## Fanout, retry, breaker, spool

Each accepted event is wrapped in an envelope
`{provider, eventId, receivedAt, payload}` (`eventId` taken from the
payload's `eventId`/`event_id`/`id` when present, else generated as
`evt_<random hex>`; `receivedAt` is RFC3339 UTC) and POSTed with
`Content-Type: application/json` and `X-Internal-Token` to the ingress.

- **Retry**: up to `EVENTGW_MAX_ATTEMPTS` (default 3) attempts, exponential
  backoff 200 ms → 800 ms, capped at 2 s (`EVENTGW_BACKOFF_BASE_MS` /
  `EVENTGW_BACKOFF_MAX_MS`).
- **Circuit breaker**: opens after `EVENTGW_BREAKER_THRESHOLD` (default 5)
  consecutive failed delivery cycles, half-opens after
  `EVENTGW_BREAKER_COOLDOWN_SECONDS` (default 30 s) with a single probe
  (checked at call time, no in-process timers — mirrors the geo-intel
  flood-risk driver pattern). While open, deliveries fail fast to the spool.
- **Dead-letter spool**: on final failure the envelope is appended as JSONL
  to `EVENTGW_SPOOL_PATH` (default `/var/spool/event-gw/deadletter.jsonl`).
  A background goroutine (`EVENTGW_DRAIN_INTERVAL_SECONDS`, default 10 s)
  re-drains the spool in order once the breaker is not open; a fully drained
  spool file is removed. Malformed "poison" lines are rotated to the end of
  the file and logged — never silently deleted. The webhook caller still gets
  `202` with `"delivery":"spooled"`; only a spool **write** failure turns the
  response into a 500.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `EVENTGW_MODE` | `stub` | `stub` or `live` — see fail-closed table. Anything else fails startup. |
| `EVENTGW_ADDR` | `:8090` | Listen address. |
| `EVENTGW_PROVIDERS` | `weather,payments,imagery` | Comma-separated provider names (lowercased; `-`/`_` interchangeable in env keys). |
| `EVENTGW_SECRET_<NAME>` | _(empty)_ | HMAC secret for provider `<NAME>` (uppercased, `-`→`_`). Required per provider in live mode. |
| `EVENTGW_SIG_HEADER_<NAME>` | `X-Signature` | Signature header for provider `<NAME>`. |
| `EVENTGW_TS_HEADER_<NAME>` | `X-Timestamp` | Timestamp header for provider `<NAME>`. |
| `EVENTGW_SIG_ENCODING_<NAME>` | `hex` | `hex` or `base64` signature encoding for provider `<NAME>`. |
| `EVENTGW_API_INGRESS_URL` | `http://localhost:3001/api/v1/internal/events` | API internal event ingress URL. |
| `EVENTGW_INTERNAL_TOKEN` | _(empty)_ | Value of the `X-Internal-Token` header on fanout. |
| `EVENTGW_SPOOL_PATH` | `/var/spool/event-gw/deadletter.jsonl` | Dead-letter spool file. |
| `EVENTGW_MAX_SKEW_SECONDS` | `300` | Timestamp skew window. |
| `EVENTGW_REPLAY_TTL_SECONDS` | `600` | Replay-cache entry TTL. |
| `EVENTGW_MAX_ATTEMPTS` | `3` | Fanout attempts per delivery cycle. |
| `EVENTGW_BACKOFF_BASE_MS` / `EVENTGW_BACKOFF_MAX_MS` | `200` / `2000` | Retry backoff base / cap. |
| `EVENTGW_BREAKER_THRESHOLD` | `5` | Consecutive failures before the breaker opens. |
| `EVENTGW_BREAKER_COOLDOWN_SECONDS` | `30` | Open duration before half-open probe. |
| `EVENTGW_DRAIN_INTERVAL_SECONDS` | `10` | Spool re-drain poll interval. |

## Run

```bash
# Dev (stub mode — verification DISABLED, loud warning):
go run ./cmd/event-gw

# Live:
EVENTGW_MODE=live \
EVENTGW_PROVIDERS=weather,payments \
EVENTGW_SECRET_WEATHER=... EVENTGW_SECRET_PAYMENTS=... \
EVENTGW_API_INGRESS_URL=http://api:3001/api/v1/internal/events \
EVENTGW_INTERNAL_TOKEN=... \
go run ./cmd/event-gw

# Sign a test webhook (hex, Unix-seconds timestamp):
BODY='{"eventId":"w-1","alert":"heavy-rain"}'
TS=$(date +%s)
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$EVENTGW_SECRET_WEATHER" -hex | awk '{print $2}')
curl -X POST localhost:8090/webhooks/weather -H "X-Signature: $SIG" -H "X-Timestamp: $TS" -d "$BODY"
```

## Docker

Multi-stage build (`golang:1.22-alpine` → `gcr.io/distroless/static-debian12`,
nonroot, `EXPOSE 8090`, `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"`).
The binary has a `-healthcheck` self-probe mode for the distroless
HEALTHCHECK (no shell in the image). A compose **service fragment** lives at
`compose.event-gw.yml` — the orchestrator merges it into
`infra/docker-compose.yml`; this directory does not touch the root compose
file.

```bash
docker build -t agric-event-gw services/event-gw
docker run --rm -p 8090:8090 -e EVENTGW_MODE=stub agric-event-gw
```

## Verification evidence (run in-sandbox, this branch)

- `go version` → `go version go1.22.12 linux/amd64` (toolchain fetched from
  dl.google.com; proxy.golang.org is blocked in the sandbox, irrelevant here
  because the module has zero dependencies).
- `go build ./...` → exit 0.
- `go test ./... -count=1` → exit 0, `ok .../internal/gateway`. **35
  top-level test functions, 73 test cases** including table-driven subtests:
  known-answer HMAC vectors (hex + base64, independently generated),
  `sha256=` prefix, wrong-secret/tampered-body rejection, skew boundaries
  (301 s past/future reject; 300/299 s accept), timestamp formats, replay
  accept-then-reject + TTL expiry + eviction, stub-vs-live behaviour,
  live-mode-missing-secret 503, unknown-provider 404, malformed-body 400
  table, replay 409 end-to-end, eventId extraction table, retry sequence
  against an `httptest.Server` that fails twice then succeeds (3 attempts
  observed), backoff schedule table, spool-on-exhaustion, breaker
  open/fail-fast, half-open close and re-open (injected clock), envelope
  shape + `X-Internal-Token` header, spool re-drain on recovery, drain keeps
  entries while failing, drain skipped while open, poison-line retention,
  healthz/readyz/metrics content, readyz degraded state, method routing,
  config defaults/overrides/bad-value table.
- `go vet ./...` → exit 0, no output.
- `gofmt -l .` → exit 0, no output.
- Binary smoke test (real process + fake ingress): stub-mode unsigned POST →
  `202 delivered`, immediate replay → `409`, loud stub warning printed;
  live-mode signed POST → `202`, unsigned/bad-signature → `401`,
  unconfigured provider → `503` naming the missing env var, FATAL startup
  notice logged, `X-Internal-Token` and envelope shape observed at the
  ingress, `/healthz` `/readyz` `/metrics` payloads verified, `-healthcheck`
  exit 0, SIGTERM → graceful `Shutdown` and clean exit.

## NOT verified / honest limitations

- **Docker build was NOT run** — no Docker daemon in the development
  sandbox. The Dockerfile is static-reviewed only; build it with the command
  above before relying on it.
- **No load profile.** "High-throughput" is a design goal (constant-time
  compares, bounded body reads, fail-fast breaker, no per-request
  allocations beyond the envelope), not a measured property; no benchmark or
  soak test has been run.
- **Single-process spool ownership.** The JSONL spool is guarded by an
  in-process mutex; run one replica per spool path (or one writer + the
  drain loop, as shipped).
- **Replay cache is in-memory** — a restart forgets recent deliveries within
  the skew window; providers can replay old-but-still-fresh signatures in
  that gap. Acceptable for an edge; persistent replay state would need Redis.
- **The API ingress contract** (`/api/v1/internal/events` + `X-Internal-Token`
  + envelope fields) is implemented as specified, but the NestJS side lives
  on another branch and has not been integration-tested against this service.
- Secrets come from the environment only; nothing is committed.
