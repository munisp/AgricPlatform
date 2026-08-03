# Integration Fabric (wave FABRIC)

Fail-closed adapters + compose profiles for the prescribed middleware stack.
The pattern is identical for every adapter (same convention as the geo-intel
flood-risk drivers and the wave P1 integration drivers):

- a **port interface** behind a DI token,
- a **STUB driver** — the default, deterministic, clearly labelled, equal to
  the pre-existing behaviour,
- a **LIVE driver** selected by env that is **FAIL-CLOSED**: the factory
  throws `ProviderConfigError` at boot when a live driver is selected
  without its configuration, and call failures raise
  `ProviderHttpError`/`ProviderRequestError` (mapped to 503 by callers),
  with a call-time circuit breaker (3 consecutive failures → 30 s open) —
  **never a silent degradation to the stub when live is selected**,
- unit tests for both drivers and the selection logic,
- an optional docker-compose profile (nothing starts by default),
- this document: exactly what is verified vs not.

**Global verification statement:** unit tests and compose-file YAML validity
are verified in CI. **No live middleware cluster was started as part of this
wave** — no Kafka produce, Temporal workflow execution, OpenSearch query,
Permify check, TigerBeetle transfer, Mojaloop simulator call, APISIX proxy,
open-appsec inspection or Sedona Spark job has been run. Docker was not
available during development, so compose validation is YAML/schema lint
only (`docker compose config` was NOT executed).

## 1. Event bus — Kafka (Redpanda locally)

- **What it does:** publishes domain events (the existing
  `{domain}.{entity}.{verb}` outbox taxonomy) to Kafka topics
  `${KAFKA_TOPIC_PREFIX:-agric.domain}.{event.name}`, keyed by event id.
  `DomainEventsService.persist()` publishes to the bus **after** the outbox
  append and **before** listener fan-out (fail closed: bus failure
  propagates → 503; the outbox row remains). The transactional post-commit
  `emit()` path publishes best-effort (state is already committed) and logs
  failures.
- **Port/token:** `EVENT_BUS` (`apps/api/src/core/events/event-bus.driver.ts`),
  provided globally by `CoreModule`.
- **Env / selection:** `EVENT_BUS_DRIVER=stub|kafka` (default `stub` =
  current in-process behaviour, a labelled no-op). `kafka` requires
  `KAFKA_BROKERS` (comma-separated); optional `KAFKA_TOPIC_PREFIX`.
- **Verified:** stub no-op + labelling; factory selection incl. fail-closed
  without `KAFKA_BROKERS`; Kafka publish envelope/topic with an injected
  fake producer; circuit breaker open/reset; `DomainEventsService` wiring
  (propagation, best-effort emit, stub unchanged). **Not verified:** real
  broker produce/consume; kafkajs against Redpanda.
- **Runbook:** `docker compose -f infra/docker-compose.yml --profile redpanda up -d`,
  then run the API with `EVENT_BUS_DRIVER=kafka KAFKA_BROKERS=localhost:9092`
  (inside compose: `redpanda:9092`).

## 2. Workflow orchestrator — Temporal

- **What it does:** multi-step workflow execution behind one port. The stub
  directly invokes locally-registered handlers in-process (today's
  behaviour: plain service calls); starting an unregistered workflow fails
  closed. One REAL workflow proves the port: **credit loan disbursement**
  (`credit.loan_disbursement`): score-check → ledger-record → notification,
  with decline short-circuiting BEFORE any ledger posting. The same
  dependency-free pipeline executor runs under both drivers (the Temporal
  workflow file replays it with proxied activities), so business logic
  cannot drift. The ledger-record step posts through the existing
  `LedgerService` double-entry invariants (solvency guard included) — the
  workflow orchestrates the existing posting path, it does not bypass it.
- **Port/token:** `WORKFLOW_ORCHESTRATOR`
  (`apps/api/src/common/orchestration/workflow-orchestrator.driver.ts`),
  global via `CoreModule`. Workflow code:
  `apps/api/src/modules/finance/workflows/`. Worker bootstrap (NOT
  auto-started): `apps/api/src/workers/temporal.worker.ts`
  (`npm run worker:temporal -w @agric-platform/api`).
- **Env / selection:** `WORKFLOW_DRIVER=stub|temporal`. `temporal` requires
  `TEMPORAL_ADDRESS`; optional `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`.
- **Verified:** stub direct invocation + result passthrough; unregistered
  workflow fails closed; factory fail-closed without `TEMPORAL_ADDRESS`;
  start args/task queue with a fake client; circuit breaker; pipeline step
  order + decline short-circuit; service mapping (balanced postings,
  solvency guard); stub registration end-to-end. **Not verified:** real
  Temporal server round-trip; worker bundle execution (the worker bootstrap
  typechecks but has not been run).
- **Runbook:** `docker compose -f infra/docker-compose.yml --profile temporal up -d`
  (UI on :8088), `npm run worker:temporal -w @agric-platform/api` with
  `TEMPORAL_ADDRESS=localhost:7233`, then run the API with
  `WORKFLOW_DRIVER=temporal TEMPORAL_ADDRESS=localhost:7233`.

## 3. Search — OpenSearch

- **What it does:** wraps the existing search-module query path
  (`/api/v1/search`, `/suggest`) behind the `SearchProvider` port. The
  OpenSearch driver serves `search`/`suggest` from the index and delegates
  `trending`/`related` to the in-process fallback (they are
  repository-computed, not index-backed). Indexing is an offline concern:
  the index mapping is `infra/opensearch/agric-platform-index.json`
  (`type`, `title`, `summary`, `state`, `indexed_at`); a reindex runbook is
  below. Unknown result types in hits are dropped (fail closed on shape).
- **Port/token:** `SEARCH_PROVIDER` (`modules/search/search.provider.ts`);
  `SearchController` now queries through the port (default binding returns
  the same `SearchService` instance — behaviour unchanged).
- **Env / selection:** `SEARCH_DRIVER=opensearch` requires
  `OPENSEARCH_NODE`; optional `OPENSEARCH_INDEX` (default
  `agric-platform`), `OPENSEARCH_USERNAME`/`OPENSEARCH_PASSWORD`,
  `OPENSEARCH_TLS_REJECT_UNAUTHORIZED=false` for demo certs. Every other
  `SEARCH_DRIVER` value keeps the current in-process search (the Meilisearch
  driver in `drivers/search.drivers.ts` is untouched).
- **Verified:** selection (fallback returned unless `opensearch`;
  fail-closed without node); query DSL shape + hit mapping; suggest
  de-duplication; trending/related delegation; error mapping (status →
  `ProviderHttpError`, transport → `ProviderRequestError`). **Not
  verified:** any live OpenSearch query/index operation.
- **Runbook:** `docker compose -f infra/docker-compose.yml --profile opensearch up -d`;
  create the index with `PUT https://localhost:9200/agric-platform` (basic
  auth `admin` / `$OPENSEARCH_ADMIN_PASSWORD`, body =
  `infra/opensearch/agric-platform-index.json`); bulk-index documents shaped
  as `SearchIndexDocument`; run the API with the env above.

## 4. Rate limiting — Redis-backed throttler storage

- **Status: predates this wave** (`apps/api/src/common/rate-limit/redis-throttler.storage.ts`,
  wired in `app.module.ts`). Redis `INCR`+`PEXPIRE` fixed-window storage
  when `REDIS_URL` is present; in-memory fallback otherwise (single-instance
  semantics, as before). Included here because it closes the multi-replica
  readiness gap and follows the same port pattern.
- **Verified:** storage unit tests (`redis-throttler.storage.spec.ts`).
  **Not verified:** multi-replica behaviour against a live Redis.

## 5. Authorization — Permify

- **What it does:** relationship-based authorization behind one port, for
  ONE resource as proof: **credit loan read** (`GET /api/v1/loans/:id`).
  The stub reproduces the current logic exactly (`assertSelfOrAdmin`:
  applicant or admin); unknown resource/action combinations deny. With the
  Permify driver selected, the controller checks
  `credit_loan`/`read` via Permify REST and fails closed (provider error →
  503, denial → 403). `RolesGuard` stays the default enforcement point
  everywhere — nothing changes unless `AUTHORIZATION_DRIVER=permify`.
- **Port/token:** `AUTHORIZATION_CHECK`
  (`apps/api/src/common/auth/authorization-check.driver.ts`), global via
  `CoreModule`.
- **Env / selection:** `AUTHORIZATION_DRIVER=stub|permify`. `permify`
  requires `PERMIFY_URL`; optional `PERMIFY_TENANT_ID` (default `t1`).
- **Verified:** stub allow/deny matrix (owner/admin/other); factory
  fail-closed without URL; REST request shape (tenant, entity, subject) and
  `RESULT_ALLOWED`/`RESULT_DENIED` mapping via mocked fetch; HTTP error
  propagation. **Not verified:** live Permify round-trip; schema write.
- **Runbook:** `docker compose -f infra/docker-compose.yml --profile permify up -d`
  (in-memory — dev only). Provision schema + tuples out-of-band, e.g.:
  `entity user {}` / `entity credit_loan { relation owner @user; relation
  admin @user; action read = owner or admin }` via
  `POST {PERMIFY_URL}/v1/tenants/{t}/schemas/write`, then
  `relationships/write` a tuple `credit_loan:{id}#owner@user:{applicantId}`.
  Then run the API with `AUTHORIZATION_DRIVER=permify
  PERMIFY_URL=http://localhost:3476`.

## 6. Ledger backend — TigerBeetle (LEGAL GATE: defaults OFF)

- **What it does:** append-only transfer backend behind one port,
  ALONGSIDE the Postgres double-entry ledger, which stays the system of
  record. **Money movement on this platform is legal-gated, so the driver
  defaults OFF and is NOT wired into `LedgerService` write paths.** The
  stub returns deterministic, clearly-labelled simulated transfer receipts
  (no money moved). The live driver posts `createTransfers` via
  `tigerbeetle-node` (lazy import) with u128 decimal-string account ids and
  integer kobo amounts. A diagnostics endpoint
  `GET /api/v1/finance/ledger/backend-status` (admin) reports the selected
  driver.
- **Port/token:** `LEDGER_BACKEND`
  (`apps/api/src/modules/integrations/drivers/tigerbeetle.driver.ts`),
  provided by `FinanceModule`.
- **Env / selection:** `LEDGER_DRIVER=stub|tigerbeetle`. `tigerbeetle`
  requires BOTH `TIGERBEETLE_ADDRESSES` (comma-separated) and
  `TIGERBEETLE_CLUSTER_ID` — missing either fails closed at boot listing
  both.
- **Verified:** stub determinism + labelling; selection incl. both-missing
  error; transfer batch contents (BigInt u128 ids/amounts) with a fake
  client; rejection mapping; malformed-id caller errors never trip the
  circuit; circuit breaker on transport failures. **Not verified:** any
  real TigerBeetle cluster interaction; account provisioning.
- **Runbook:** `docker compose -f infra/docker-compose.yml --profile tigerbeetle up -d`
  (init formats the data file once; remove `tigerbeetle-init` on re-runs),
  then `LEDGER_DRIVER=tigerbeetle TIGERBEETLE_ADDRESSES=localhost:3000
  TIGERBEETLE_CLUSTER_ID=0`. Legal sign-off is required before ANY wiring
  into money movement.

## 7. Payments interop — Mojaloop (simulator path)

- **What it does:** quote + transfer interop behind one adapter port,
  following the payments driver pattern. The stub returns deterministic,
  clearly-labelled simulated quotes/transfers. The live driver targets a
  Mojaloop SIMULATOR (mojaloop-simulator / Mojaloop Testing Toolkit) with
  FSPIOP-shaped `POST /quotes` and `POST /transfers`.
  **There is NO full Mojaloop deployment: a real switch is helm-chart scale
  and out of compose scope.** The simulator path proves the adapter
  contract only; no live Mojaloop flow has been executed.
- **Port/token:** `MOJALOOP_ADAPTER`
  (`apps/api/src/modules/integrations/drivers/mojaloop.driver.ts`),
  provided by `IntegrationsModule`.
- **Env / selection:** `MOJALOOP_DRIVER=stub|simulator`. `simulator`
  requires `MOJALOOP_SIM_URL` (fail closed otherwise).
- **Verified:** stub determinism + labelling; selection; FSPIOP quote
  request shape + response mapping via mocked fetch; COMMITTED mapping;
  circuit breaker on HTTP errors. **Not verified:** any simulator/switch
  round-trip.
- **Runbook:** run a simulator (e.g. `mojaloop/mojaloop-simulator` or the
  testing toolkit, outside this repo), then
  `MOJALOOP_DRIVER=simulator MOJALOOP_SIM_URL=http://localhost:4044`.

## 8. Identity — Keycloak realm `agricplatform`

- The keycloak service stays in the base dev stack (not profile-gated —
  unchanged). Its import volume now mounts the whole `./keycloak` directory,
  so BOTH realms import: the legacy dev realm `agric-platform`
  (`realm-export.json`, unchanged behaviour; `lender` + `enumerator` roles
  added additively) and the wave-FABRIC canonical realm `agricplatform`
  (`infra/keycloak/realm-agricplatform.json`).
- **Realm contents:** roles `farmer`, `buyer`, `partner`, `chapter_lead`,
  `lender`, `enumerator`, `admin`; clients `agric-web` (public, PKCE) and
  `agric-api` (**confidential**, service accounts enabled, placeholder
  secret `CHANGE-ME-local-dev-only` — rotate via Keycloak admin and export
  as `OIDC_CLIENT_SECRET`; never commit a real secret).
- **Pointing the API at it:** `OIDC_ISSUER=http://localhost:8080/realms/agricplatform`,
  `OIDC_AUDIENCE=agric-web` (or the confidential client id, matching how
  tokens are issued), `OIDC_CLIENT_SECRET=<rotated secret>`.
- **Verified:** realm JSON validity. **Not verified:** Keycloak import run
  or token issuance.

## 9. API gateway — APISIX (profile: apisix)

- `apache/apisix` in **standalone data-plane mode** reading the declarative
  `infra/apisix/apisix.yaml` (mounted with `infra/apisix/config.yaml`):
  route `/api/*` → `api:3001` with `limit-count` (120 req/min/IP, mirroring
  the app throttler) and a **placeholder** `key-auth` credential
  (`local-dev-partner-key` — documented placeholder, rotate before real
  use); route `/*` → `web:3000`. `bitnami/etcd` is provisioned in the
  profile for teams that prefer the traditional admin-API mode — the
  default declarative mode does not use it.
- **Verified:** YAML validity of both config files. **Not verified:**
  APISIX boot or any proxied request.

## 10. Edge security — open-appsec (profile: openappsec)

- `ghcr.io/openappsec/agent` + `ghcr.io/openappsec/nginx-attachment` in
  front of web/api (edge on :8090, proxy config
  `infra/openappsec/nginx-proxy.conf`), following the vendor's nginx
  compose layout (shared-memory attachment over `ipc: host`). Policy
  management requires EITHER a SaaS profile token (`APPSEC_AGENT_TOKEN`) OR
  a local policy file dropped into `infra/openappsec/localconf/`.
- **Verified:** compose YAML validity. **Not verified:** agent/attachment
  boot, policy load, or any inspected request. This profile is a scaffold.

## 11. Batch geo analytics — Apache Sedona (profile: sedona)

- One-shot Spark/Sedona job (`infra/sedona/batch-geo.py` + README) reading
  the MinIO lakehouse parquet (`dim_listings`) over S3A, aggregating
  listings per state and proving spatial SQL (`ST_DistanceSphere` against
  the Nigeria state centroid table). **Batch only — NOT wired into any
  request path.** `--profile sedona up -d` also starts MinIO (profile
  overlap); the job itself runs via `--profile sedona run --rm sedona`.
- **Verified:** Python syntax compile; compose YAML validity. **Not
  verified:** any Spark/Sedona execution or S3A read.

## 12. GeoLibre — evaluation (not integrated)

See `docs/integration-matrix.md` § “GeoLibre evaluation (wave FABRIC)” —
summary: GeoLibre is a full end-user GIS application (Tauri desktop/mobile
app + hosted web app + a Jupyter-oriented Python wrapper), not an
embeddable JS/Python geo library, so it does not fit the admin geo map or
the flood-ml sidecar. Not integrated; no code depends on it.
