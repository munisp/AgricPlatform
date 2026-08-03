# Operations runbook (Wave OPS)

Scope: deploy, verify, rollback, and on-call alert response for the
AgricPlatform API. Companion runbooks: [dr.md](dr.md) (backup/DR),
[go-live-checklist.md](go-live-checklist.md) (human gates),
[observability.md](observability.md) (logging/metrics internals),
[deployment.md](deployment.md) (environment topology).

Tooling referenced here:

| Command | Purpose |
| --- | --- |
| `npm run verify:providers` | Probe every configured external provider (postgres + migration level, redis, OIDC, paystack, termii, weather). PASS/FAIL/SKIP per provider; exit 0 only if all configured providers pass. |
| `npm run verify:deployment` | Post-deploy gate: production env present, migrations current, `/health/ready` responds. |
| `npm run backup:db` | Timestamped pg_dump + SHA-256 + row-count manifest (+ optional S3 upload). |
| `npm run verify:restore` | DR drill: restore latest backup into a scratch DB and validate table counts. |
| `npm run sweep:outbox` | One outbox relay pass (cron-triggered in production). |

## Deploy

1. Confirm CI is green on the target commit (`ci-gate` job).
2. Confirm secrets are provisioned in the secret manager
   (see `infra/k8s/secrets-provisioning.md`): `DATABASE_URL`, `REDIS_URL`,
   `OIDC_ISSUER`, `OIDC_AUDIENCE`, `ATTENDANCE_SIGNING_SECRET`,
   `VET_SIGNING_SECRET`, plus any non-stub integration driver credentials.
   The API refuses to boot when these are missing (fail-closed), so a bad
   secret set surfaces as CrashLoopBackOff, not silent misbehaviour.
3. Roll out the new image (kustomize overlay under `infra/k8s/overlays/`).
4. Apply pending migrations **before** the new pods take traffic:
   `DATABASE_URL=… npm run migrate -w @agric-platform/api`
   (idempotent; recorded in `schema_migrations`).

## Verify (post-deploy gate — run every deploy)

```sh
# Against the live environment's shell context (CI deploy job or bastion):
API_BASE_URL=https://api.example.com/api/v1 npm run verify:deployment
```

Expected: `==> deployment verification PASSED`, exit 0. Any FAIL line names
the exact problem (missing env, migrations behind, readiness not 200).

Provider-level probe (weekly, and after any credential rotation):

```sh
npm run verify:providers
```

SKIP lines are acceptable for optional integrations; FAIL is not. The
script never prints secret values, so its output is safe to paste into
tickets/chat.

## Rollback

1. Revert the deployment to the previous image tag
   (`kubectl rollout undo deployment/agric-api -n agric-platform` or the
   GitOps revert for the overlay).
2. **Migrations**: migrations are additive and forward-only — do NOT roll
   the database back with the app. If a migration itself is the problem,
   restore from backup per [dr.md](dr.md) and treat it as an incident.
3. Re-run `npm run verify:deployment` against the rolled-back version.
4. Post an incident note if user traffic was affected (see
   [incident-response.md](incident-response.md)).

## On-call alerts → actions

Alerts are defined in `infra/observability/alerts.yml`; each carries a
`severity` (`page`/`warn`) and a short `action`. Expanded steps:

### AgricApiDown (page)

1. `kubectl get pods -n agric-platform` — crashlooping? Check pod logs;
   fail-closed boot guards name the missing config in the FATAL line.
2. Pods healthy? Curl `/api/v1/health/live` from inside the cluster.
3. Endpoint answers but Prometheus still shows down? The scrape credential
   broke: `/api/v1/metrics` now requires `Authorization: Bearer
   $METRICS_TOKEN` (or an admin OIDC token) and returns 401 anonymously in
   production. Verify the `credentials_file` configured for the `agric-api`
   scrape job still holds a valid token.

### AgricApiHigh5xxRate (page)

1. Grafana → "HTTP 5xx rate by route" panel to find the failing routes.
2. `GET /api/v1/health/ready` — a `down` dependency (postgres/redis)
   usually explains a broad 5xx spike.
3. Sentry for the exception (only 5xx are captured).
4. Dependency down → fail over / restart per infra docs; app bug →
   rollback (above).

### AgricApiHighLatencyP95 (warn)

1. Grafana → "p95 latency by route" to isolate.
2. Check postgres (slow queries, connection pool saturation) and redis.
3. Sustained saturation → scale the API deployment; hot-query regression
   → rollback and open a perf ticket.

### AgricOutboxBacklogGrowing / AgricOutboxOldestPendingOld (warn/page)

1. The outbox sweeper is externally scheduled (cron/CronJob running
   `scripts/sweep-outbox.mjs`). Confirm the schedule still runs and the
   `ADMIN_TOKEN` it presents is still valid.
2. Run one manual sweep: `API_BASE_URL=… ADMIN_TOKEN=… npm run sweep:outbox`.
3. A single stuck row (age alert with small backlog): the listener for
   that event type throws every pass. Find `outbox relay failed` in the
   API logs, fix the listener, re-sweep. Rows dead-letter after 8 attempts.

### AgricOutboxDeadLetters (page)

Events were lost after exhausting retries. List dead letters via the admin
outbox surface, fix the root cause, then replay. Consumer-side dedup makes
replay safe.

### AgricNotificationDlqNonEmpty / AgricNotificationQueueStuck (warn)

1. `npm run verify:providers` — check termii/whatsapp/mailgun credentials
   and reachability.
2. Provider outage: queued messages drain automatically once it recovers;
   DLQ entries need an operator decision (requeue vs. accept loss) — see
   the notifications module docs.

### Escrow invariants (page)

`AgricEscrowNegativeBalance` and `AgricEscrowStuckPendingState` are
funds-integrity incidents:

1. Freeze escrow transitions (feature flag / deploy block).
2. Stuck `releasing`/`refunding`: the intent was persisted BEFORE the
   provider call, so the transition is safely re-drivable. Verify the
   provider side (`npm run verify:providers`, provider dashboard), then
   re-drive the transition as admin.
3. Negative locked amount: reconcile escrow records against orders and the
   ledger before ANY further releases/refunds. Escalate to payments
   on-call immediately.

### AgricOtpLockoutStorm / AgricIdempotentReplayStorm (warn)

Likely abuse or a broken client. Identify sources in the API logs
(`requestId` correlated), tighten throttler limits or block the client per
`docs/security-compliance.md` §7.
