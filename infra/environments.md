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
- Health: API `/health` endpoint monitored by CI smoke checks.

## staging

- Mirrors production topology (same container images, same manifests via
  kustomize overlays) with reduced scale.
- Receives the exact artifact that will be promoted to production.
- Release gates run here: R1/R2/R3 readiness checklists, NDPR workflow
  verification (consent, export, deletion), notification sandbox delivery
  tests, and load smoke tests.

## production

- Deploys only through a manual GitHub Environment approval (`deploy.yml`).
- Database: managed PostgreSQL with PITR backups; Redis-compatible managed
  cache. The k8s manifests in `infra/k8s/` cover stateless web/api tiers;
  stateful services are managed services, not in-cluster pods.
- Secrets live in AWS Secrets Manager (or equivalent) and are injected by the
  platform — never committed, never printed in CI logs.
- Audit logging (`admin.audit_events`) and the domain event outbox
  (`events.outbox`) must be verified healthy after every deploy.

## dr (disaster recovery)

- Standby posture until cloud infrastructure is formally provisioned.
- Restore order: database (latest PITR snapshot) → Redis (cold start OK,
  cache/idempotency only) → Keycloak realm re-import + secret re-issue →
  stateless tiers from the last known-good image tag → DNS cutover.
- Target RPO: 15 minutes (PITR). Target RTO: 4 hours (documented runbook).
- Failover and failback are manual, runbook-driven procedures; a DR drill is
  required before R3 Launch.

## Promotion rules

1. CI builds and tests once; the resulting image tag is the promotion unit.
2. `main` merge deploys to staging automatically.
3. Staging sign-off (manual approval) promotes the same tag to production.
4. Rollback = redeploy the previous tag; database migrations must be
   backward-compatible within a release window.
