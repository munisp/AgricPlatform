# Runbook: Deployment

Pipeline: `.github/workflows/ci.yml` (build/test/scan gate) →
`.github/workflows/deploy.yml` (image push → staging → approved production).
Environment model: `infra/environments.md`.

## 1. Prerequisites

| Item | Where | Status |
| --- | --- | --- |
| GitHub Environments `staging` and `production` with required reviewers | Repo settings → Environments | Manual setup per `scripts/github-bootstrap.md` |
| `KUBECONFIG_B64` secret on each environment | Environment secrets | EXTERNAL — needs a provisioned cluster |
| `API_HEALTH_URL` variable on each environment (e.g. `https://api.staging.example/api/v1/health`) | Environment variables | EXTERNAL — needs DNS/ingress |
| GHCR package write (via `GITHUB_TOKEN`) | Automatic | Ready |
| `agric-secrets` provisioned in each cluster | `infra/k8s/secrets-provisioning.md` | EXTERNAL — needs the secret store |

Until the environment secrets exist, deploy jobs skip the cluster apply with
a `::notice::` and the workflow stays green — nothing is silently "deployed".

## 2. Normal release (merge to main)

1. CI gate (`ci-gate`) must be green: install, lint/typecheck, tests, builds,
   gitleaks, blocking npm audit, Trivy image scan, smoke test.
2. Merge to `main` (squash). `deploy.yml` builds and pushes
   `ghcr.io/<owner>/agric-{api,web}:<sha>` and applies
   `infra/k8s/overlays/staging` with that tag pinned via
   `kustomize edit set image`.
3. Verify staging:
   - rollout status in the workflow log,
   - `curl -fsS $API_HEALTH_URL` and `$API_HEALTH_URL/ready`,
   - release-gate checks per `docs/production-readiness.md` when applicable.
4. Promote: approve the `production` environment deployment in the Actions
   UI. The **same image tag** is applied with
   `infra/k8s/overlays/production`.
5. Post-deploy verification (production):
   - health + ready endpoints green,
   - `admin.audit_events` receiving events and `events.outbox` consumers
     draining,
   - one synthetic golden-path request per critical journey.

## 3. Manual deploy of an existing tag

Actions → Deploy → Run workflow → set `image_tag`. The push job is skipped on
manual runs; the tag must already exist in GHCR (it was pushed by an earlier
`main` run).

## 4. Rollback

Rollback = redeploy the previous image tag (§ 3). There is no data rollback:
database changes must be backward-compatible within a release window
(`infra/environments.md` § Promotion rules). If a migration is destructive,
treat it as a data incident and follow `docs/runbooks/backup-restore.md`.

## 5. Database migrations

Status: the API currently runs against in-memory repositories; migrations
land with the PostgreSQL persistence work (Sprint 1 in
`docs/production-readiness.md`). When they exist, run them as a pre-deploy
step in `deploy.yml` against the target environment before rolling the API
deployments, and keep them backward-compatible so rollback stays safe.

## 6. Provider driver changes

Driver flips (`stub` → `sandbox` → `production`) are config-overlay changes
in `infra/k8s/overlays/*/patch-config.yaml`, never code changes. Production
flips additionally require the credential to exist in the secret store and a
live smoke test — see `docs/integration-matrix.md`.

## 7. Freeze and hotfix

- Freeze windows (release gates R1–R3): no merges to `main` without
  maintainer approval.
- Hotfix: branch `hotfix/<scope>` from the latest tag, PR to `main`, normal
  CI gate, then deploy. Do not bypass the `production` environment approval.
