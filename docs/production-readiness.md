# Production Readiness — AgricPlatform

**Assessment date:** 2026-08-02  
**Assessment scope:** Nigeria Farmer Platform PRD v3.3, Phase 1 reference implementation, GitHub handoff, and production launch gap analysis.  
**Verdict:** **Ready for technical review, local demo, and staging hardening. Not ready for public production launch.**

## 1. Executive readiness score

| Dimension | Score | Evidence | Remaining gate |
| --- | ---: | --- | --- |
| Phase 1 product-surface coverage | 92% | All major PRD domains have frontend routes wired to the live NestJS API (typed client, session context, replayable offline queue, J1–J4 + cross-cutting) | Real OIDC sign-in flow in the web app; deepen Phase 2 modules |
| Build and test health | 100% | Typecheck, lint, `lint:sql` (2 migrations), 249 automated tests passing (176 API + 68 web + 5 shared; 51 pg-gated skips), API build, and 18-route Next.js production build pass | Keep these checks required on `main` |
| Persistence readiness | 85% (code-complete) | Async repository ports with 27 PostgreSQL repositories selected by `DATABASE_URL`, drift-aligned `infra/postgres/001_init.sql`, `migrate`/`seed` CLIs, Redis idempotency/OTP stores behind `REDIS_URL`, fail-closed production config, and in-memory/pg contract suites | Run the DATABASE_URL/REDIS_URL-gated suites against real containers (docker unavailable in the build environment) and soak in staging |
| Identity and access readiness | 75% | Keycloak OIDC/JWKS bearer verification (`jose`), ownership-or-admin authorization across sensitive routes, hardened OTP (expiry/attempts/lockout, no dev code in production), throttling, fail-closed production auth config | Hosted Keycloak realm, OTP SPI + Termii SMS, web OIDC login flow |
| Integration readiness | 55% | Provider registry, local stubs, adapter matrix, environment flags | Sandbox/live credentials and provider-specific drivers |
| Infrastructure readiness | 65% | Dockerfiles with documented digest-pinning policy, Compose, Kubernetes base + staging/production overlays (HPAs, PDBs, NetworkPolicies, production security contexts), hardened CI/CD (gitleaks, blocking audit, Trivy, smoke tests), backup/restore scripts and CronJob example, ops runbooks | Execute and harden in target cloud; provision clusters/secret stores; run backup/restore and DR drills |
| Security and compliance readiness | 60% | RBAC + OIDC, webhook HMAC, idempotency, tamper-evident audit hash chain, privacy export/delete, CSP/security headers on web, WCAG AA automated checks, secret hygiene, compliance documentation | Pen test, DPO/legal review, residency, monitoring evidence, credentials |
| **Overall Phase 1 engineering readiness** | **82%** | All engineering-controllable waves code-complete: security, frontend wiring, persistence, observability, accessibility/i18n; deterministic local gates green | Container verification of the pg/Redis suites, hosted IdP, provider sandboxes, staging hardening |
| **Public production readiness** | **40%** | Launch blockers remain external and operational (legal, credentials, penetration test, uptime evidence) | Close L1–L10 in `docs/security-compliance.md` |

The implementation should be treated as a **production-oriented reference platform**, not as a live production system. The most important next engineering milestone is a staging build that uses PostgreSQL, Redis, and Keycloak end to end.

## 2. What is implemented now

### Repository and delivery foundation

- Single npm-workspaces monorepo with `apps/web`, `apps/api`, and `packages/shared`.
- Reproducible dependency lockfile (`package-lock.json`).
- Shared TypeScript domain contracts, Nigerian state and value-chain fixtures, profile scoring, status enums, role enums, and utility tests.
- Root validation commands for typecheck, lint, tests, and production builds.
- GitHub Actions CI/deploy workflows with least-privilege permissions, gitleaks secret scanning, blocking dependency audit, container builds with Trivy image scans, and a built-process smoke test; Dependabot configuration, CODEOWNERS, pull-request template, and issue templates.
- Kustomize overlays for staging and production (`infra/k8s/overlays/`) with replica counts, HPAs, PDBs, NetworkPolicies, per-environment config/driver overrides, and production container security contexts; committed secret manifests removed in favour of `infra/k8s/secrets-provisioning.md`.
- Backup/restore assets: `scripts/backup-postgres.sh`, `scripts/restore-postgres.sh`, `infra/k8s/backup-cronjob.yaml`, and runbooks under `docs/runbooks/`.
- GitHub operating model in `docs/github-strategy.md` and command handoff in `scripts/github-bootstrap.md`.

### Frontend reference PWA

`apps/web` implements a Next.js App Router PWA with 18 generated routes:

- `/` landing page
- `/onboarding`
- `/dashboard`
- `/learning`
- `/community`
- `/opportunities`
- `/chapters`
- `/marketplace`
- `/finance`
- `/advisory`
- `/admin`
- `/partner`
- `/privacy`
- `/integrations`
- `/search`
- `/offline`
- `/_not-found`
- service-worker and manifest support

Implemented frontend behaviours include role-aware dashboard state, onboarding, opportunity browsing, marketplace listing capture, chapter attendance recording, notification preferences, privacy controls, cross-domain search, offline fallback, and local persistence for draft/offline-like interactions.

**Frontend API wiring (frontend wave, code-complete):** every primary journey reads and mutates the live NestJS API through a typed client (`apps/web/lib/api/`) with envelope unwrapping, timeout, automatic `Idempotency-Key` on mutations, Bearer/`x-user-id` auth-provider hook, and 429 backoff. A session context provides identity with an explicitly-marked dev role preview. The offline queue is replayable: submissions carry method/path/payload/idempotency key, flush on reconnect/interval/manual retry, and render real queued/sending/sent/failed statuses. Wired journeys: J1 onboarding/register, dashboard, opportunities + applications, notification preferences; J2 marketplace listings and idempotent orders; J3 chapters, events, RSVP/attendance, community topics, mentor requests; J4 learning enrolment/progress/certificates, admin console, partner reports, finance credit profile + document vault, privacy consents/export/delete; plus search, advisory, integrations, and home metrics cross-cutting. All 14 wired routes ship `loading.tsx`/`error.tsx`; the service worker (v3) caches only public GET reference data network-first; baseline CSP, `nosniff`, `Referrer-Policy`, and `Permissions-Policy` headers are set in `next.config.ts` and asserted by tests.

### Backend modular API

`apps/api` implements a NestJS modular API under `/api/v1` with modules for:

- auth and users
- profiles and dashboard
- learning and certificates
- community
- opportunities
- chapters and attendance
- advisory
- marketplace
- finance and credit readiness
- notifications
- admin and partner workflows
- analytics
- privacy export/delete
- search
- integrations and provider health

Cross-cutting implementation includes validation, security headers, CORS, request logging, API exception mapping, idempotency interception, role guards, audit events, domain events, seed data, health/live/ready endpoints, and OpenAPI documentation at `/api/v1/docs`.

**Security hardening (backend wave):** the API verifies Keycloak OIDC bearer tokens against the realm JWKS (`jose`), keeping the `x-user-id` header only outside production or with `ALLOW_DEV_HEADER_AUTH=true`, and refuses to boot in production without OIDC configuration. OTP challenges expire, track attempts, and lock out after five failures; the dev code is never returned in production. Rate limiting (`@nestjs/throttler`, in-memory) guards all routes with stricter limits on auth/OTP/notification/webhook endpoints — **Redis-backed storage is the follow-up so limits hold across replicas**. Sensitive per-user routes (privacy export/delete/consents, notification send/preferences/deliveries, finance document vault, marketplace mutations, chapter management/attendance, integration status) enforce authentication with ownership-or-admin checks. Provider webhooks verify an HMAC-SHA256 signature over the preserved raw body (bypass only for stub drivers outside production) and replayed signed payloads are idempotent. Marketplace order transitions follow an actor-scoped state machine over `ORDER_STATUSES`. Swagger is disabled in production unless `ENABLE_API_DOCS=true`, and non-stub integration drivers without credentials fail the production boot.

### Automated behaviour evidence

Current automated tests verify these representative flows:

- course enrolment through certificate issuance
- public certificate verification
- idempotent request replay
- duplicate opportunity-application rejection
- role-based access control
- audit-event emission
- cross-domain search
- NDPR-style data export and deletion
- OpenAPI document availability
- shared profile scoring, badge assignment, opportunity matching, and naira formatting

**Observability (backend wave, code-complete):** structured JSON logging via pino with request-id propagation (`x-request-id` honored and echoed), secret/PII redaction, and quiet health probes; Prometheus metrics at `/api/v1/metrics` (`http_requests_total`, `http_request_duration_seconds`, and the `agric_*` domain series — see `docs/runbooks/observability.md`); env-gated Sentry error tracking (`SENTRY_DSN`; fully disabled without one, 5xx-only capture, `beforeSend` scrubbing); readiness generalized to a dependency-indicator registry (`skipped` never degrades, configured+down ⇒ `degraded`); and a tamper-evident audit hash chain with `GET /api/v1/admin/audit-log/verify` (migration `002_audit_hash_chain.sql`). Prometheus/Grafana dashboards, alert rules, and Sentry delivery with a real DSN remain external verification items.

## 3. Adapter-ready integrations

The API contains a provider registry and local adapters in `apps/api/src/modules/integrations/`. `.env.example` defaults every external provider to a stub driver so the repository remains buildable and testable without secrets.

| Domain | Local status | Production requirement |
| --- | --- | --- |
| SMS / OTP | Stub driver and delivery status surface | Termii or Twilio credentials, sender registration, live smoke test |
| WhatsApp | Stub driver | 360dialog/Meta credentials, approved templates, webhook verification |
| Email | Stub driver | Mailgun or SendGrid credentials and verified sending domain |
| Push | Stub driver | OneSignal application credentials |
| Payments | Stub driver | Paystack/Flutterwave sandbox then live credentials; legal approval for fees and escrow |
| LMS | Stub bridge | Moodle URL, token, SSO, webhook configuration |
| Community | Stub bridge | Discourse URL, API key, SSO secret |
| CMS | Fixture-backed content path | Directus URL and token when activated |
| Search | Stub search with Meilisearch path | Self-hosted Meilisearch/OpenSearch; no third-party credential required for Meilisearch |
| Weather/advisory | Stub weather adapter | OpenMeteo is directly usable; NiMet requires an institutional agreement |
| Identity | Local header stub plus Keycloak realm assets | Hosted Keycloak, OIDC client secrets, OTP SPI, Termii SMS |

The complete provider-by-provider evidence model is maintained in `docs/integration-matrix.md`.

## 4. External dependencies and launch blockers

Engineering cannot close the following without third parties or operating environments:

1. Third-party penetration test and remediation sign-off.
2. NDPR/NDPA legal review and Data Protection Officer appointment.
3. Privacy policy and Terms of Service publication, including Pidgin versions required by the PRD.
4. Production credentials for Keycloak hosting, Termii/Twilio, WhatsApp/360dialog, email, push, and payments.
5. Cloud environment provisioned in an approved Nigeria/West Africa residency pattern.
6. Backup schedule, monitored restore drill, RTO/RPO evidence, and DR rehearsal.
7. Sixty days of monitored uptime evidence for the production gate.
8. Paystack/Flutterwave live escrow and settlement approval, including board-approved fees and Nigerian legal review.
9. NIBSS/NIMC agreements before BVN/NIN-backed KYC tier progression.
10. NiMet, FMARD, AFEX, NCX, farmOS, Kobo/ODK, and donor/partner data agreements where those feeds are activated.

These map to blockers L1–L10 in `docs/security-compliance.md`.

## 4a. Accessibility + i18n foundations (code-complete; external verification pending)

The `production-a11y-i18n` wave (plan: `docs/roadmap/observability-a11y-plan.md`, workstream B) is code-complete in `apps/web`:

- **Automated a11y checks (headless):** jsx-a11y gap rules enabled as eslint errors on top of the six rules `eslint-config-next` 16 bundles; jest-axe smoke tests cover form/ui primitives plus `OpportunityBrowser` and `OnboardingWizard` composites inside the real providers; `test/contrast.test.ts` parses `globals.css` and asserts WCAG AA luminance ratios (badge-info fixed 3.82:1 → 5.54:1, badge-critical 4.51:1 → 5.63:1, `--ink-mute` 4.53:1 → 5.08:1).
- **Hardening:** 44px touch targets (`.btn-small`, `.chip`, `.nav-links a`), reusable `.sr-only`, skip-link target focus (`tabIndex={-1}`), `fieldset`/`legend` filter group, live result count, per-card apply labels, `aria-describedby` hint wiring, blanket `prefers-reduced-motion`, accessible metric trends and queue status badges.
- **i18n foundations:** typed English dictionary (source of truth) with low-literacy rules documented; empty Hausa/Yoruba/Igbo `DeepPartial` scaffolds with per-key English fallback (no machine translation committed); `I18nProvider` persists locale to `agric.locale` and updates `<html lang>`; labelled locale switcher in nav and footer; strings extracted for nav, dashboard, opportunities, learning, marketplace and onboarding chrome. Everything else stays hardcoded pending translation review.
- **PWA:** service worker v3 caps the page cache at 50 entries (FIFO), resolves offline failures with real Responses (504 JSON for `/api/*`, `Response.error()` for assets), and gates activation behind a user-confirmed "Update available" banner (`SKIP_WAITING` message + `controllerchange` reload). Manifest declares 192/512 PNG icons — **the binary assets are an external design task** (entries reference `public/icon-192.png`/`icon-512.png`, not yet committed).

**External verification still required (cannot run in this environment):** TalkBack/NVDA screen-reader passes, real Lighthouse a11y + PWA runs, PWA installability on physical Android, keyboard walkthrough, service-worker update flow end-to-end, outdoor/sunglare contrast on real screens, and native-speaker review of future ha/yo/ig translations.

## 5. Known implementation gaps

| Priority | Gap | Why it matters | Recommended owner |
| --- | --- | --- | --- |
| P0 | ~~Frontend uses shared/local fixtures rather than live API data~~ All primary journeys wired to the live API with typed client, session context, and replayable offline queue | Real OIDC sign-in flow in the web app remains (dev session preview today); fixtures survive only as clearly-marked offline fallbacks | Frontend + Identity lead |
| P0 | ~~API repositories are in-memory~~ PostgreSQL persistence implemented behind `DATABASE_URL` (fail-closed in production) | pg repositories, migrations, and seeds are code-complete but not yet executed against a live database (no docker in the build environment) | API lead |
| P0 | ~~Local auth uses `x-user-id` header stub~~ OIDC bearer verification implemented; Keycloak realm hosting and OTP SPI remain external | API verifies JWTs; the IdP itself is not yet provisioned | Identity lead |
| P1 | Rate limiting store is in-memory | Throttler limits do not hold across replicas; idempotency and OTP stores moved behind `REDIS_URL` with Redis/in-memory drivers | API lead + DevOps |
| P1 | Observability pipeline is code-complete but unverified end-to-end | Metrics/logging/Sentry/audit-chain ship in the API; Prometheus scrape, Grafana dashboards, alert rules, and Sentry delivery with a real DSN need a live environment | API lead + DevOps |
| P0 | Docker and Kubernetes assets have not been executed in this environment | Deployment bugs may remain | DevOps lead |
| P1 | External providers are stubs only | OTP, payments, notifications, LMS, and community cannot be live-proven | Integrations lead |
| P1 | Financial ledger is schema/spec ready but not the active runtime store | Marketplace and credit flows need durable balanced records | Finance engineering + counsel |
| P1 | i18n content is contract-ready but not fully translated | Hausa, Yoruba, Igbo launch requirements remain open | Product + localisation |
| P1 | Accessibility, 3G performance, and page-weight budgets need device-level audits | PRD has explicit WCAG and low-bandwidth NFRs | Frontend lead + QA |
| P2 | Analytics are fixture/reference level | Production KPI definitions need warehouse/event data | Data lead |
| P2 | Advanced Appendix A architecture is intentionally deferred | Kafka, Temporal, TigerBeetle, Mojaloop, Dapr, APISIX, and SOC tooling are scale/phase triggers | Architecture lead |

## 6. Release recommendation

### Ready now

- Create the private GitHub repository and push `main`.
- Enable required CI checks, secret scanning, Dependabot, and CODEOWNERS review.
- Use the build for stakeholder walkthroughs, UX review, API contract review, and implementation planning.
- Start a staging-hardening track using the existing PostgreSQL, Keycloak, and Compose/Kubernetes assets.

### Not ready for

- Public farmer registration.
- Real OTP-based authentication.
- Real payments, escrow, disbursement, credit decisions, or KYC tier activation.
- Production PII storage.
- Claims of NDPR/NDPA compliance, financial compliance, uptime, or provider deliverability.

## 7. Next execution plan

### Sprint 1 — staging foundation

1. Create GitHub repository and apply `scripts/github-bootstrap.md` settings.
2. Deploy the existing Compose stack in a disposable staging environment.
3. ~~Replace API in-memory repositories with PostgreSQL repositories~~ Done in the persistence wave (`production-persistence` branch): pg implementations behind `DATABASE_URL`, aligned `001_init.sql`, `npm run migrate`/`npm run seed` CLIs.
4. Add migration execution (`npm run migrate -w @agric-platform/api`) to deployment and CI.
5. Run the API e2e and repository contract suites against PostgreSQL and Redis containers (external blocker: docker is unavailable in the build environment; suites are in place behind `DATABASE_URL`/`REDIS_URL`).

### Sprint 2 — identity and journey wiring

1. ~~Replace `x-user-id` local auth with Keycloak OIDC~~ Done API-side in the security wave (JWKS verification, fail-closed production config); remaining: hosted realm + web login flow.
2. Wire frontend login, session, logout, and role guards to the hosted Keycloak (frontend session context and auth-provider hook are in place; the OIDC redirect/code flow is the remaining piece).
3. ~~Replace frontend fixture reads with API clients~~ Done in the frontend wave; localStorage remains only for offline drafts, the replay queue, and locale/session preferences.
4. Exercise Journey J1 end to end with stub OTP and notifications (all endpoints wired; run against a staged API).

### Sprint 3 — provider sandboxes

1. Add Termii sandbox OTP and delivery callbacks.
2. Add Paystack test-mode payment and webhook replay tests.
3. Add Moodle and Discourse sandbox bridges.
4. Add OneSignal and email sandbox smoke tests.
5. Label every result as `sandbox`; do not count it as live evidence.

### Sprint 4 — launch hardening

1. Run Lighthouse/3G, axe, API load, and security-header checks in CI/staging.
2. Execute backup and restore drills.
3. Configure uptime, error, audit, and provider-delivery monitoring.
4. Complete legal/privacy documents and DPO appointment.
5. Conduct the third-party penetration test and resolve launch-critical findings.

## 8. Validation evidence from the current source tree

The final merged-main validation completed successfully from a clean detached worktree after `npm ci`, using both:

```bash
npm run validate
SKIP_INSTALL=1 bash scripts/validate-repo.sh
```

Results (final merged main, post-hardening waves):

- API typecheck: passed
- Web typecheck, including generated Next.js route types: passed
- Shared package typecheck: passed
- ESLint (incl. jsx-a11y gap rules): passed
- Migration lint (`lint:sql`, pgsql-ast-parser): 2 migration files, all statements parsed, PK/DROP guards passed
- API tests: 176 passed (+51 PostgreSQL-gated contract tests skipped without `DATABASE_URL`)
- Web tests: 68 passed (API client, offline queue, security headers, a11y axe, contrast, i18n, PWA)
- Shared package tests: 5 passed
- Total automated tests: 249 passed
- NestJS production build: passed
- Next.js production build: passed
- Static routes generated: 18
- All-in-one production process smoke test: passed (`npm run start`, web page title, and `/api/v1/health`)
- Heuristic tracked-file secret scan: passed
- Tracked `.env` file check: passed

Docker, Docker Compose, Kubernetes, and external provider calls were not executed in this environment because the container runtime is unavailable. Dockerfiles, Compose, and Kubernetes probes were statically aligned with the verified production start command and `/api/v1/health` endpoints. Those items remain staging-verification tasks rather than locally proven evidence.

The operations-hardening wave (hardened workflows, kustomize overlays, backup/restore scripts and CronJob, runbooks, digest-pinning policy) was validated statically in the same environment: `bash -n` syntax checks on all scripts and YAML parse checks on every workflow and manifest. Container builds, Trivy scans, gitleaks, and cluster applies execute on GitHub-hosted runners once the repository is pushed; cluster-dependent deploy steps skip with an explicit notice until environment credentials are provisioned.

## 9. Final handoff statement

AgricPlatform is a coherent, validated monorepo that converts PRD v3.3 into an executable Phase 1 reference architecture. It is intentionally honest about boundaries: local stubs make the code deterministic, adapter interfaces preserve the production migration path, and all legal, regulatory, credential, uptime, and live-provider gates remain explicit. The correct next step is controlled staging hardening, not public launch.
