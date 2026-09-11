# AgricPlatform Environments

AgricPlatform promotes immutable build artifacts across environments. No
long-lived environment branches exist; configuration changes flow through
overlays and environment-scoped secrets, never through code forks.

## Environment matrix

| Concern | local | dev | staging | production | dr |
|---|---|---|---|---|---|
| Purpose | Developer machine, offline-friendly | PR/integration validation | Production-like UAT and release gates | Live NYFN users | Disaster-recovery standby |
| Code source | Working tree | PR head / `main` merge queue | Tagged build from `main` | Same artifact as staging, promoted | Replicated production artifacts |
| Data | Disposable Docker volumes | Ephemeral, reset on demand | Synthetic + anonymised fixtures | Real member data (NDPR scope) | Replicated backups (async) |
| Providers | Stub drivers | Stub or sandbox keys | Sandbox keys (Paystack test, Termii sandbox) | Production credentials | Cold standby credentials |
| Secrets | `.env` (git-ignored), local-only defaults | GitHub Environment `dev` secrets | GitHub Environment `staging` + cloud secret store | Cloud secret store only, no human-readable copies | Sealed copies of production secrets |
| Deploy trigger | Manual (`docker compose`) | CI on PR / merge to `main` | Automatic on merge to `main` | Manual approval via GitHub Environment | Manual failover runbook |
| Data residency | n/a | n/a | n/a | Nigeria-preferred region | Secondary region |

## local

Run the reference stack with Docker Compose:

```bash
# Core services only (recommended default)
docker compose -f infra/docker-compose.yml up -d postgres redis keycloak meilisearch

# Point the apps at them
cp .env.example .env
npm install && npm run dev

# Full containerised stack including web/api images
docker compose -f infra/docker-compose.yml --profile apps up -d --build

# Optional open-source integrations for adapter development
docker compose -f infra/docker-compose.yml --profile integrations up -d
```

Postgres is initialised from `infra/postgres/001_init.sql` on first boot
(delete the `postgres-data` volume to re-run). Keycloak imports
`infra/keycloak/realm-export.json`; the admin console is at
http://localhost:8080 (admin/admin, local only). All drivers default to
`stub`, so no external credentials are needed.

## dev

- Deployed automatically from CI for pull requests and merges to `main`.
- May be torn down and recreated at any time; never store anything durable.
- Uses sandbox provider keys held in the GitHub `dev` Environment.
- Health: API `/api/v1/health` endpoint monitored by CI smoke checks.

## staging

- Mirrors production topology (same container images, same manifests via
  kustomize overlays) with reduced scale. Overlay:
  `infra/k8s/overlays/staging` (1 replica per tier, sandbox provider drivers,
  small HPAs, PDBs, NetworkPolicies). The deploy workflow pins the image tag
  with `kustomize edit set image` before `kubectl apply -k`.
- Receives the exact artifact that will be promoted to production.
- Release gates run here: R1/R2/R3 readiness checklists, NDPR workflow
  verification (consent, export, deletion), notification sandbox delivery
  tests, and load smoke tests.

## production

- Deploys only through a manual GitHub Environment approval (`deploy.yml`).
  Overlay: `infra/k8s/overlays/production` (3 API / 2 web replicas with HPAs,
  PDBs, NetworkPolicies, hardened container security contexts). Provider
  drivers remain `stub` in the overlay until live credentials exist in the
  secret store.
- Database: managed PostgreSQL with PITR backups; Redis-compatible managed
  cache. The k8s manifests in `infra/k8s/` cover stateless web/api tiers;
  stateful services are managed services, not in-cluster pods. Logical
  backups: `scripts/backup-postgres.sh` and the example CronJob
  `infra/k8s/backup-cronjob.yaml`; procedures in
  `docs/runbooks/backup-restore.md`.
- Secrets live in AWS Secrets Manager (or equivalent) and are injected by the
  platform — never committed, never printed in CI logs. Provisioning options
  (External Secrets Operator, sealed-secrets, manual bootstrap):
  `infra/k8s/secrets-provisioning.md`.
- Audit logging (`admin.audit_events`) and the domain event outbox
  (`events.outbox`) must be verified healthy after every deploy
  (`docs/runbooks/deployment.md`).

## dr (disaster recovery)

- Standby posture until cloud infrastructure is formally provisioned.
- Restore order: database (latest PITR snapshot) → Redis (cold start OK,
  cache/idempotency only) → Keycloak realm re-import + secret re-issue →
  stateless tiers from the last known-good image tag → DNS cutover.
- Target RPO: 15 minutes (PITR). Target RTO: 4 hours (documented runbook).
- Failover and failback are manual, runbook-driven procedures; a DR drill is
  required before R3 Launch.

## Optional platform components (stage25)

New wave-integrated components, all opt-in (compose profiles / explicit k8s
apply) so the reference stack stays unchanged. All images pinned; no
`latest`; no real secrets anywhere.

| Component | local (compose) | k8s (dev/staging) | production posture |
|---|---|---|---|
| Dapr (placement + daprd sidecars for api / event-gw) | `--profile dapr` (+ `apps`/`event-gw`); components in `infra/dapr/components/` (pub/sub → Redpanda, state → Redis), tracing → `otel-collector:4317` via `infra/dapr/config.yaml` | `infra/k8s/dapr/` (Helm chart `dapr/dapr` 1.18.3 + Component/Configuration CRs + injector-annotation patch for the api Deployment) | Sidecar model per workload; samplingRate patched down; components scoped per app-id |
| Fluvio streaming | `--profile fluvio`; SC `:9003`, SPU `:9010/:9011`, pinned `infinyon/fluvio:v0.18.1`, one-shot `fluvio-sc-setup` registers SPU 5001 | `infra/k8s/fluvio/` (official charts from release assets `fluvio-chart-sys/app.tgz` @ v0.18.1, minimal `values.yaml`) | Multi-SPU, storage classes; metrics scrape TBD per chart version |
| Mojaloop switch | `--profile mojaloop`; Testing Toolkit pair only (hub emulator for `MOJALOOP_DRIVER=simulator`, TTK API `:4040`, UI `:6060`) | `infra/k8s/mojaloop/` — official Helm chart `mojaloop/mojaloop` **17.2.0** + `example-mojaloop-backend` (full switch: ALS, quoting, transaction-requests, ml-api-adapter, central-ledger + TTK + simulators) | Helm chart + backend chart, per-env values, JWS/TLS from secret store |
| GeoLibre web GIS | `--profile geolibre`; built from pinned upstream tag v2.8.0, nginx on `:8300` (`infra/geolibre/`) | `infra/k8s/geolibre/deployment.yaml` (Deployment + Service, `/healthz` probes; not in base kustomization) | Static tier behind ingress; image promoted like web/api |

Adapter env contract for the live Mojaloop driver (stub remains the
default): `MOJALOOP_ALS_ENDPOINT`, `MOJALOOP_QUOTING_ENDPOINT`,
`MOJALOOP_TRANSFERS_ENDPOINT`, `MOJALOOP_DFSP_ID` — values per path in
`infra/mojaloop/README.md`; commented examples on the compose `api` service
and `.env.example`.

Env contract for the other stage25 API drivers (stub remains the default for
each; selecting a driver without its config fails closed at boot):
`EVENT_BUS_DRIVER=fluvio` requires `FLUVIO_ENDPOINT` (SC host:port; compose
profile `fluvio` exposes `localhost:9003`), optional `FLUVIO_TOPIC_PREFIX`
(default `agric.domain`). The API/temporal-worker OpenTelemetry SDK
(`apps/api/src/common/telemetry/telemetry.sdk.ts`) is controlled by
`OTEL_ENABLED` (default enabled; `false` = complete no-op),
`OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`, the hub
collector from compose profile `observability`), `OTEL_SERVICE_NAME`
(default `agric-api`) and `OTEL_TRACES_SAMPLER_ARG` (head-sampling ratio
0..1). Placeholders in `.env.example`; per-env values come from the env
secret store.

Observability per component: Dapr has native OTLP tracing (config above) and
Prometheus metrics on sidecar `:9090`; Fluvio logs via stdout (`RUST_LOG`)
with Prometheus metrics from SC/SPU (scrape path to confirm against the
pinned chart); Mojaloop services expose Prometheus `/metrics` on their admin
ports natively; GeoLibre nginx access logs stream to stdout (filelog
alternative noted in `infra/geolibre/nginx.conf`). Scrape/merge snippets are
in the stage25 W3 report for the observability overlay owner.

## Promotion rules

1. CI builds and tests once; the resulting image tag is the promotion unit.
2. `main` merge deploys to staging automatically.
3. Staging sign-off (manual approval) promotes the same tag to production.
4. Rollback = redeploy the previous tag; database migrations must be
   backward-compatible within a release window.
