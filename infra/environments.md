# Environments and promotion

The platform runs three environments. Promotion is one-way:
`dev → staging → production`, with a tagged release and a passing
verification gate at each step.

| Environment | Purpose | Data | Deploy trigger |
| --- | --- | --- | --- |
| dev | Feature integration, daily development | Synthetic seed only | Every merge to `main` |
| staging | Pre-production rehearsal, partner UAT | Synthetic + anonymised fixtures | Tagged release candidate (`rc-*`) |
| production | Live service | Real member data | Manual approval on the `production` environment, tagged release only |

## Rules

1. **No production deploy without staging soak.** A release candidate must
   run in staging for at least one business day with
   `scripts/verify-deployment.mjs` green before production approval.
2. **Migrations run forward-only.** A deploy applies pending migrations
   (`npm run migrate -w @agric-platform/api`); rollbacks are new
   migrations, never edited history (docs/runbooks/ops.md).
3. **Secrets are per-environment** and never committed
   (infra/k8s/secrets-provisioning.md). Rotating a secret follows
   docs/security/key-rotation.md.
4. **Feature flags are per-environment.** A flag enabled in staging is NOT
   automatically enabled in production; production flag flips are admin
   actions recorded in the audit chain.
5. **Provider drivers default to `stub` everywhere except an explicit,
   reviewed production configuration.** A production pod with a stub
   payments/notifications driver is an incident, not a configuration.

## Verification gates

- Merge to `main`: typecheck, lint, unit + e2e tests, migration lint
  (`lint:sql`), dependency audit gate.
- Release candidate: the above plus `verify:deployment` against staging.
- Production approval: the above plus a signed-off staging soak report.
