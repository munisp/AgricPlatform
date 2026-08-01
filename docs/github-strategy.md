# AgricPlatform GitHub Repository Strategy

## Recommendation
Use one private monorepo named `AgricPlatform`. A single repository is the right Phase 1 choice because the platform has tightly coupled domain contracts, one delivery team, shared UI/API types, and coordinated release gates. Publish selected SDK/UI packages later; do not split services into separate repositories before Phase 2 scale justifies it.

## Repository layout
- `apps/web` — Next.js PWA for members, admins, chapter leads, buyers, partners.
- `apps/api` — NestJS modular API.
- `packages/shared` — shared domain types, constants, fixtures, utilities.
- `infra` — local stack, deployment, environment and CI/CD assets.
- `docs` — architecture, analysis, readiness, operational documentation.
- `scripts` — validation and maintenance scripts.

## Branching model
- `main`: always releasable; protected.
- `feat/<scope>`: short-lived feature branches.
- `fix/<scope>`: defect branches.
- `chore/<scope>`: maintenance branches.
- `release/<version>`: optional hardening branch for R1/R2/R3 gates.
- `hotfix/<scope>`: emergency production fixes from the latest tag.

No long-lived environment branches. Promote immutable build artifacts from staging to production.

## Environments
- `local`: developer machine with local stubs.
- `dev`: pull-request/integration environment.
- `staging`: production-like validation and UAT.
- `production`: live users.
- `dr`: disaster-recovery standby when cloud infrastructure is provisioned.

## Branch protection
On `main`:
- Require pull request and at least one approval; two approvals for finance, payments, infra, auth, and shared contracts.
- Require CI checks: install, lint, typecheck, tests, API build, web build, secret scan.
- Require conversation resolution and up-to-date branches.
- Use squash merges and linear history.
- Block force pushes, deletions, and direct commits.
- Add CODEOWNERS for web, API, shared contracts, infra, and docs.

## CI/CD
1. Install with `npm ci` and cache dependencies.
2. Lint and typecheck.
3. Unit tests and coverage.
4. Build API and web.
5. Gitleaks secret scan (blocking) plus blocking `npm audit --omit=dev --audit-level=high`; full-tree audit stays advisory while Phase 1 dependencies stabilise.
6. Container image builds for `infra/docker/api.Dockerfile` and `infra/docker/web.Dockerfile`, gated by Trivy scans (HIGH/CRITICAL, unfixed findings ignored).
7. Smoke test of the built production processes (API `/api/v1/health` + web `/`).
8. Deploy to staging on merge to `main` via `infra/k8s/overlays/staging` (skipped with a notice until cluster credentials exist on the GitHub Environment).
9. Deploy to production only through manual GitHub Environment approval, promoting the same image tag via `infra/k8s/overlays/production`.
10. Tag releases with semantic versions and attach readiness checklists.

All workflows run with least-privilege `permissions` (default `contents: read`; only the image push job gets `packages: write`).

## Secrets
No secrets in Git. Use `.env.example` for documentation only. Real credentials belong in GitHub Environments for CI and AWS Secrets Manager or equivalent for runtime. Local development defaults to stub providers. Kubernetes secret material is never committed — see `infra/k8s/secrets-provisioning.md` (External Secrets Operator, sealed-secrets, or manual bootstrap).

## Labels and planning
- `type: feature|bug|chore|docs|security|debt|spike`
- `domain: identity|learning|community|opportunity|chapter|marketplace|finance|notification|advisory|analytics|admin|infra`
- `module: M1..M18`
- `phase: P1|P2|P3`
- `release: R1|R2|R3`
- `priority: P0|P1|P2|P3`
- `gate: connectivity|ndpr|security|legal|payments`
- `status: blocked|ready|needs-adr|needs-design`

## Milestones
- `R1 Alpha`: identity, farmer dashboard, learning, community.
- `R2 Beta`: opportunities, chapters, advisory, notifications.
- `R3 Launch`: admin, partner workspace, analytics, security hardening.
- `Phase 2`: marketplace, credit readiness, WhatsApp, mobile, partner revenue.
- `Phase 3`: recommendations, lakehouse, USSD, commodity exchange, SDK.

## Initial GitHub push
After validating the local repository:
```bash
git remote add origin git@github.com:<org-or-user>/AgricPlatform.git
git push -u origin main
```
Then enable branch protection, environments, secrets, Dependabot, code scanning, and required status checks.
