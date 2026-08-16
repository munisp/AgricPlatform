# Production Readiness — AgricPlatform

**Assessment date:** 2026-08-16 (stats refreshed during the Stage 21 mission-critical assurance audit; earlier Stage 9/10 closure summaries below are retained as historical record)  
**Assessment scope:** Nigeria Farmer Platform PRD v3.3, Phase 1 reference implementation, GitHub handoff, and production launch gap analysis.  
**Verdict:** **Ready for technical review, local demo, and staging hardening. Not ready for public production launch.** The Stage 21 assurance audit additionally confirmed critical (C1) application-security gaps that must close before any public launch — see §5a.

## 1. Executive readiness score

| Dimension | Score | Evidence | Remaining gate |
| --- | ---: | --- | --- |
| Phase 1 product-surface coverage | 98% | All Phase 1 domains wired end to end, plus Stage 8 completions: QR attendance check-in, analytics CSV/PDF export UI, IndexedDB form drafts (registration/enrolment/listing), data-usage indicator, offline-pack scaffold | Real OIDC sign-in flow in the web app |
| Phase 2 module coverage | 90% | M7 escrow/invoicing/logistics, M8 services marketplace, M9 ledger/credit/lenders/loans, M11 programmes, M12 pathways, M14 knowledge base, M16 trending/related — all implemented API + web with migrations 003/004; Stage 10 closed the residual gaps (WhatsApp listing LGA capture, USSD HTTP e2e, trending-query cold-start blend, real ssh2 SFTP transport, Redis sliding-window partner rate bucket) | Live settlement, BVN/NIN verification, Directus/Moodle live sync (external) |
| Build and test health | 100% | Typecheck, lint, `lint:sql` (41 migrations), 3,101 automated tests passing (2,463 API + 440 web + 30 shared + 18 SDK + 150 mobile; 91 pg-gated skips in 4 spec files), API + web production builds, bundle budget gate (< 250KB enforced in CI) — all re-measured 2026-08-16, see §8 | Keep these checks required on `main` |
| Persistence readiness | 90% (code-complete) | 171 repository provider registrations (async ports, in-memory + pg) across 41 migrations; fail-closed production config; Redis stores | Run the pg/Redis-gated suites against real containers and soak in staging |
| Identity and access readiness | 45% on `main`; **70% on Stage 22 merge** | Keycloak OIDC/JWKS bearer verification (`jose`), hardened OTP (expiry/attempts/lockout, no dev code in production), throttling, fail-closed production auth config. The Stage 21 audit confirmed the guarded-route claim did not hold (§5a C1-1…C1-3). **Stage 22 update (CI-verified on open PRs, pending merge):** PR #38 closes the unguarded-route class across users/opportunities/profiles/dashboard/finance/credit/advisory/community/learning/analytics and restricts self-registration to `SELF_REGISTRATION_ROLES`; PR #42 authenticates the Africa's Talking USSD/IVR/agent callbacks and makes PIN/OTP flows race-safe; PR #40 turns the dev-header flag fatal in production | Merge PRs #38/#40/#42 (plus the ci.yml smoke-env maintainer step documented in #40); hosted Keycloak realm, OTP SPI + Termii SMS, web OIDC login flow |
| Integration readiness | 85% | Real HTTP drivers, fail-closed, 188 mocked-fetch test cases across 20 spec files under `modules/integrations`: Termii SMS + Twilio failover, 360dialog WhatsApp, Mailgun + SendGrid, OneSignal, Paystack + Flutterwave (init/verify/refund/escrow-release + webhook signatures), Meilisearch, OpenMeteo live weather (keyless), FEWS NET/NiMet ingestion scaffold, Moodle/Discourse/Directus bridge clients. Stage 21 caveat — resolved on PR #39 (CI-verified, pending merge): the generic webhook verifier computed HMAC-SHA256 while live Paystack signs HMAC-SHA512; PR #39 dispatches provider-native verification (Paystack HMAC-SHA512, Flutterwave static verif-hash, generic SHA-256 otherwise), re-drives verified-but-unprocessed events instead of losing them, and makes the outbox sweeper await bus acceptance before marking rows published | Fix provider-native webhook verification; sandbox/live credentials; NiMet payload MoU; delivery-rate evidence |
| Infrastructure readiness | 65% | Dockerfiles with documented digest-pinning policy, Compose, Kubernetes base + staging/production overlays (HPAs, PDBs, NetworkPolicies, production security contexts), hardened CI/CD (gitleaks, blocking audit, Trivy, smoke tests), backup/restore scripts and CronJob example, ops runbooks | Execute and harden in target cloud; provision clusters/secret stores; run backup/restore and DR drills |
| Security and compliance readiness | 65% | RBAC + OIDC, webhook HMAC, idempotency with body-mismatch 409, tamper-evident audit hash chain, signed QR attendance secrets fail-closed, export audit logging, privacy export/delete, CSP/security headers, WCAG AA automated checks, secret hygiene | Pen test, DPO/legal review, residency, monitoring evidence, credentials |
| **Overall Phase 1+2+3 engineering readiness** | **97% feature coverage; correctness under audit** | All engineering-controllable scope code-complete through Stage 20 — every PRD feature area has code, including the IVR voice channel; deterministic local gates green. The Stage 21 assurance audit (§5a) confirmed feature completeness but found C1/C2 defects in authorization coverage, fail-closed stub gating, and migration tooling that feature coverage metrics do not capture | Fix §5a findings; container verification of pg/Redis suites; hosted IdP; provider sandboxes; staging hardening |
| **Public production readiness** | **35%** on `main`; **50% on Stage 22 merge** (Stage 21 reduced 50%→35%) | Feature build-out complete, but launch blockers are no longer only external: the Stage 21 audit confirmed critical internally-fixable gaps (unguarded user/profile/finance routes, self-service admin role assignment, stub identity/insurance drivers reachable in production, non-idempotent migration tooling) alongside the external blockers (legal, credentials, penetration test, uptime evidence, translations) | Merge the Stage 22 PR set (#36–#43 — all CI-verified; #40 also needs the documented ci.yml smoke-env maintainer step), apply the two workflow-scope CI edits documented in #36/#40, then L1–L10 in `docs/security-compliance.md` |

The implementation should be treated as a **production-oriented reference platform**, not as a live production system. The most important next engineering milestone is a staging build that uses PostgreSQL, Redis, and Keycloak end to end.

## 1a. PRD v3.3 implementation percentage (Stage 10, 2026-08-02)

**Methodology.** The requirement denominator is the full PRD v3.3 set: 18 modules (M1–M18), 10 epics with 23 enumerated MVP user stories, 12 NFR categories, Appendix E (5 principles + 7 stakeholder contracts), Appendix F (8 connectivity design responses + 4 lightweight channels), Appendix G (6 integration patterns + 3 API/SDK surfaces + 36 readiness-gate items). Two tiers are reported so externally-gated evidence is never counted as engineering-complete:

| Tier | Scope | Score | Basis |
| --- | --- | ---: | --- |
| **Tier A — Phase 1 (MVP) scope** | 10 MVP modules, 23/23 user stories, Phase 1 NFRs, Appendix F Phase-1 rows | **95%** | All stories and modules implemented and test-evidenced; deducts for externally-gated Phase 1 gate items (USSD live on Africa's Talking, SMS ≥99% delivery evidence across 4 carriers, Lighthouse live 3G scores, live FEWS NET/NiMet + e-Extension feeds, DPO/legal sign-off) |
| **Tier B — whole document (P1+P2+P3)** | All 18 modules full scope, all appendices | **92%** | Weighted by phase effort (P1 45% × 95%, P2 35% × 90%, P3 20% × 90%). Stage 9 built the Phase 3 engineering scope: USSD channel (full menu engine), recommendation engine, KPI data marts + ETL (lakehouse handoff layer), public SDK + developer portal, embedded widgets, farmOS/OFN/NCX/AFEX/ODK/KoboToolbox/lender/e-Extension ACL adapters, Partner API, mobile app shell. Stage 10 added the IVR voice channel (the last unbuilt feature), closed all seven wave-reported residual gaps, and shipped the remaining frontend surfaces (recommendations rail, admin insights, federation admin, camera QR check-in, webinar registrations) |
| Tier B, engineering-controllable items only | Same denominator minus pure external blockers | **≈97%** | Excludes items no code can close: live credentials, ⚖ legal/regulatory reviews, pen test, uptime evidence, partner agreements, professional translation, SDK registry publish, partner adoption, live IVR/USSD telephony provisioning |

**What remains genuinely unbuilt (engineering-doable):** **No PRD feature area is absent from code.** Every PRD v3.3 feature area — all 18 modules, all Appendix F channels (USSD, IVR, WhatsApp, PIN swap), all Appendix G integration patterns — has an implementation with tests. Note the scope of this claim: it is a *feature-coverage* statement as of the Stage-9/10 build-out, not a correctness guarantee — the Stage 21 assurance audit (§5a) confirmed defects inside implemented areas, and external gaps (evidence, provisioning, legal review, adoption) remain.

### Stage 9 closure summary (waves P5a–P5e, merged through c4ebae2)
- **P5a** — Phase 3 federated integrations: farmOS/LiteFarm sync (consent-gated links), OFN listing syndication + order webhooks, NCX/AFEX price feeds, ODK/KoboToolbox beneficiary import (staged → dedup → admin-confirm merge), input-finance bidirectional API (consented credit-readiness push), NAERLS/FMARD e-Extension pull. Migration 007. +96 tests.
- **P5b** — USSD channel: Africa's Talking callback (fail-closed), full menu state machine (register / price check / opportunities / course confirmation, 182-char turns incl. prefix, 3-min TTL + sweeper, idempotent replay), WhatsApp guided-chat workflows (listing creation, advisory, tap-to-confirm), shared-device PIN session swap (5-attempt/15-min lockout). Migration 008. +71 tests.
- **P5c** — M16 Phase 3 recommendation engine (explainable reason codes, cold-start trending fallback, Beta-smoothed feedback loop) + M13 full: segmentation, registration/chapter funnels, weekly cohort retention (Africa/Lagos), KPI data marts (`analytics_marts` schema, idempotent ETL snapshots, columnar CSV export). Migration 009. +81 tests.
- **P5d** — Partner API (client-credentials JWT, scoped consented reads/writes, HMAC webhook dispatch, 1000/min rate buckets), `@agric-platform/sdk` v0.1.0 (ESM+CJS, 3 auth modes, retries + idempotency), developer portal (/developers, docs, sandbox keys, guides), 4 embedded widget bundles + CORS embed feeds. Migration 010. +80 tests.
- **P5e** — Per-user `/mine` list endpoints (bookings, pathway enrolments, cohort enrolments, webinar registrations) replacing device-local workarounds + `apps/mobile` Expo/React Native shell (Login/Home/Courses/Marketplace/Profile, typed API client, offline queue, CI job). +13 mobile tests, +12 api/web tests.

### Stage 10 closure summary (waves P6a–P6c, merged through bf79a21)
- **P6a — IVR voice channel (the last unbuilt PRD feature):** Africa's Talking Voice webhook (`POST /api/v1/ivr/callback`, form-encoded → `text/xml`), pure call-flow engine mirroring the USSD menu map (price check, advisory, registration status, course enrolment status, repeat/escalate, 3-strike polite END), `<Enqueue/>` escalation placeholder with `callback_request` effect, terminal-turn idempotent replay, 10-minute call TTL + sweeper, fail-closed production gating identical to USSD. Migration 011 (`channels.ivr_calls`). +50 tests.
- **P6b — residual hardening (7/7 gaps closed):** Redis sliding-window partner rate bucket (fail-open to memory, documented); farm-data pushes persisted to `integrations.farm_records` when linked with replay-safe `inbound_events` pending-link ledger otherwise; real ssh2 SFTP transport (env-gated, fail-closed, 5s timeout); USSD HTTP e2e (stub-404 + sandbox CON/END traversal ≤182 chars incl. prefix); WhatsApp listing flow LGA capture step; duplicate package.json lint key removed; cold-start recommendations blend trending queries (reason `trending_query`). +28 tests.
- **P6c — frontend surfaces (6/6):** recommendations rail on `/dashboard` (reason-code chips, optimistic feedback with failure restore); `/admin/insights` (segmentation viewer, member/chapter funnels, weekly retention heatmap, mart snapshots + CSV export); `/admin/integrations` (federation links/revoke, farm-records sync, staged-import confirm-merge, channel status cards); camera QR attendance check-in (getUserMedia + jsQR, graceful denied/unsupported fallback to paste); `/knowledge` "My registrations"; 28 new web tests + axe a11y gate; bundle 204.7KB < 250KB budget.

**Known Stage 10 design notes (documented in code, not defects):** IVR agent escalation is an `<Enqueue/>` placeholder pending provider-side call-centre provisioning; IVR prompts are English TTS pending professional voice recordings; unlinked partner farm-data pushes ledger in `inbound_events` (FK-safe) rather than `farm_records`; camera QR loop is unit-tested with mocked canvas/jsQR — one manual device check recommended before launch.

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

`apps/web` implements a Next.js App Router PWA with 61 `page.tsx` routes (measured 2026-08-16; the list below shows the original core set):

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

## 5a. Stage 21 mission-critical assurance audit (2026-08-16)

A seven-dimension adversarial audit (money paths, authN/Z & channels, fail-closed stubs, idempotency/replay, test & CI integrity, migration safety, docs honesty) was run against `main` @ `324dea5`. Every finding below was reproduced against the source tree by the audit lead before inclusion; no finding is asserted on agent testimony alone. Full detail: Stage 21 audit report (audit working artifact; see PR description).

**Confirmed critical (C1) — must close before any public launch:**

| # | Finding | Location |
| --- | --- | --- |
| C1-1 | Unauthenticated user record mutation and directory read (`PATCH /users/:id`, `GET /users`, `GET /users/:id` have no auth guard; only a global throttler exists) | `apps/api/src/modules/users/users.controller.ts:42-60`; `apps/api/src/app.module.ts:178` |
| C1-2 | Unauthenticated application-approval workflow — an attacker can self-approve grant/subsidy applications (`POST /opportunities/:id/apply` with attacker-chosen `userId`, then `PATCH /opportunities/applications/:id/status {status:'successful'}`) | `apps/api/src/modules/opportunities/opportunities.controller.ts:113-165` |
| C1-3 | Self-service role assignment at registration — `POST /auth/register` accepts `roles:['admin']` verbatim, with no OTP proof preceding account creation | `apps/api/src/modules/auth/auth.controller.ts:41-43`; `apps/api/src/modules/users/users.service.ts:60` |
| C1-4 | NIN stub identity driver verifies beneficiaries in production (no production stub ban on the factory; stub verdict is a publicly computable hash), gating real subsidy-voucher money | `apps/api/src/modules/input-vouchers/identity.driver.ts:114-125`; `input-vouchers.service.ts:330-365` |
| C1-5 | Parametric-insurance triggers evaluate on fabricated stub weather/flood data in production and book real ledger payouts marked `paid` (no `isProduction` reference anywhere in the module) | `apps/api/src/modules/insurance/insurance.service.ts:239-250,477-538,623-755` |
| C1-6 | Input-voucher redeem vs expire/void race double-debits the programme liability (ledger posting commits before the status CAS; the two operations use different idempotency keys, so both postings can commit) | `apps/api/src/modules/input-vouchers/input-vouchers.service.ts:558-577,649-685` |
| C1-7 | Migration runner is not idempotent against Compose-bootstrapped databases — `015`'s unguarded `ADD CONSTRAINT` aborts re-application, so new migrations (including this audit's 041) cannot be delivered via the supported tooling on that path; and a mid-file failure of `001` is silently recorded as fully applied by the `identity.users` baseline probe | `infra/postgres/015_query_indexes.sql:73-75`; `apps/api/src/database/migrate.ts:31,54-62`; `infra/docker-compose.yml:18-21` |

**Confirmed high (C2) — systemic classes:** missing auth guards as a *class* across profiles/dashboard/finance-reads/advisory/community/learning/analytics-mutation routes; `ALLOW_DEV_HEADER_AUTH=true` in production is warn-and-continue (every sibling guard throws); Africa's Talking USSD/IVR/agent-banking callbacks have no provider-authenticity check (caller-controlled `phoneNumber` authenticates voucher redemption sessions); Partner API defaults to the published sandbox signing secret in production when `PARTNER_API_DRIVER` is unset; PIN-swap attempt counter is non-atomic (TOCTOU defeats the 5-attempt lockout); inbound webhook/federation dedupe is recorded *before* processing with no reprocessor, so a transient failure permanently loses verified events; the outbox sweeper marks rows published before async bus delivery completes; marketplace payment/escrow lifecycle is fully declarative (no verify-before-credit — `deposit_paid` is buyer self-declared and order completion auto-releases escrow and marks invoices paid without payment evidence); float top-up requests and keyless voucher issuance lack idempotency keys (retry → duplicate settleable top-ups / duplicate signed money-bearing vouchers); input-voucher budget/cap enforcement is TOCTOU; the audit hash chain forks under concurrent/multi-replica writers and has no DB-level immutability or tail-truncation protection; `lint:sql` does not guard `DROP COLUMN`/`DROP CONSTRAINT`/unguarded `ADD CONSTRAINT`; VSLA (037), input-voucher (035), and core order/booking (001/004) money columns lack CHECK constraints of the class fixed for agent banking in migration 041.

**Audit confirmations (verified sound):** ledger core invariants and atomic posting; webhook HMAC fail-closed posture; OTP driver boot-forbidden in production; OIDC boot assertions; transactional outbox on credit/savings/loan/warehouse flows; voucher HMAC + exactly-once redemption CAS; the CI gate suite (npm-audit-gate fail-closed on broken endpoint, bundle budget fail-closed, no `continue-on-error` on blocking gates, no secret echoes); zero real or real-looking secrets in the repo; zero fake-green patterns (no `.only`, no vacuous assertions, no swallowed failures).

**Disposition:** this audit's in-scope fixes shipped as migration `041_agent_banking_amount_checks.sql` (agent-banking amount/commission CHECK constraints) plus the documentation refresh above.

### Stage 22 fix dispositions (2026-08-16)

Every C1/C2/C3 finding above received a fix across eight workstream PRs. Verification standard: the full CI gate on each PR (unit tests incl. new regression suites, lint/typecheck, `lint:sql` + pg contract suite against real Postgres, gitleaks, Trivy, built-process smoke) is green unless a cell says otherwise. **Until these PRs merge, `main` remains in the §5a state above and the scores in §1 stay at the `main` values.**

| Finding(s) | Fix PR | Disposition |
| --- | --- | --- |
| C1-1 unguarded user routes; C1-2 self-approvable applications; C1-3 self-service admin role; C2 guard class (profiles/dashboard/finance/credit/advisory/community/learning/analytics); C2 `ALLOW_DEV_HEADER_AUTH` warn-only; C3 insurance controller dead guards; C3 OIDC algorithm pin | #38 | Fixed; class-level `RolesGuard`, admin/self-or-admin scoping, actor-derived authorship (impersonating body fields removed from DTOs), `SELF_REGISTRATION_ROLES` allowlist with 400 on privileged roles, dev-header flag throws in production, RS256 pinned. CI green |
| C1-4 NIN stub verifying in production; C1-5 insurance stub triggers booking real payouts; C2 partner-api published sandbox secret in production; C3 warehouse-pledge / livestock-passport stubs; C3 NODE_ENV casing; C3 default webhook secret | #40 | Fixed; production factory bans (boot-throwing), stub-basis verdicts ⇒ 503 with nothing persisted/posted, partner-api requires `PARTNER_API_DRIVER=live` + a private signing secret, `isProduction()` normalization across all call sites, boot rejects `local-development-only`/short webhook secrets. Unit/typecheck CI green; **smoke job red by design** — the new boot guards correctly refuse the current smoke env, and the PR body carries the exact ci.yml smoke-env lines a maintainer must apply (the automation token lacks `workflow` scope) |
| C1-6 redeem vs expire/void double-debit; C3 agent-banking redeem/void race; C2 top-up + keyless issuance idempotency; C2 budget/cap TOCTOU | #37 | Fixed; `REDEEMING`/`EXPIRING`/`VOIDING` pending states with CAS-before-posting plus rollback/resume, unified idempotency keys, required top-up/issuance keys (migration 042; legacy NULL keys grandfathered), programme-row `FOR UPDATE` allocation lock. CI green |
| C1-7 migration tooling not re-apply-safe; C2 lint:sql gaps; C2 CHECK-constraint gaps (035/037/001/004); C4 test/lint hygiene batch | #36 | Fixed; 015's FK add is `pg_constraint`-guarded, the baseline probes `events.processed_events` (partial-001 trap closed) plus a latest-artifact probe map, new lint rules with unit tests, migration 044 adds 19 CHECKs, 001's 59 tables are `IF NOT EXISTS`. CI green. **Companion migrate-twice CI step** is a maintainer-applied edit (workflow scope; exact snippet in PR body) |
| C2 webhook dedupe-before-processing event loss; C2 sweeper premature publish; C3 Paystack SHA-512 vs generic SHA-256 | #39 | Fixed; provider-native signature dispatch, `processed_at`-backed re-drive of duplicate-unprocessed deliveries with a 5xx retry contract plus an admin sweep endpoint, sweeper awaits bus acceptance before `markPublished`. CI green |
| C2 declarative escrow (no verify-before-credit) | #43 | Fixed; `deposit_paid` requires a provider reference verified server-side (status + exact kobo amount), production without a payment driver ⇒ 503, completion is blocked for unverified deposits (migration 045). CI green. Documented remainder: provider-backed release/refund rails stay declarative pending a PSSP disbursement API |
| C2 audit-chain fork risk | #41 | Fixed; migration 043 (fail-loud history validation, NOT NULL + lowercase-hex CHECKs, `UNIQUE(prev_hash)` fork rejection), atomic guarded `INSERT…SELECT` append with bounded jittered retry and no per-process tail cache, pg `created_at` round-trip hash-stability fix. CI green incl. the pg contract suite. Documented residual: tail truncation needs an external anchoring checkpoint (follow-up) |
| C2 unauthenticated AT callbacks; C2 PIN attempt TOCTOU; C3 OTP per-phone cap + leading-zero space | #42 | Fixed; shared callback token gate + optional IP allowlist + mid-session phone binding (boot-fatal when the driver is live without a token), atomic PIN attempt increment (`UPDATE…RETURNING` / synchronous in-memory), per-phone rolling OTP failure cap (429) and the full 6-digit code space. CI green |

**Known Stage 22 follow-ups (tracked, none silent):** (1) two `.github/workflows/ci.yml` edits need a `workflow`-scoped maintainer token — the db-contract migrate-twice step (#36) and the smoke-env additions (#40); (2) audit-chain tail-truncation anchoring (#41 migration header); (3) provider-backed escrow release/refund rails (#43 PR body); (4) merge-order conflicts are expected in `.env.example` (#38/#40/#42 overlap) and `agent-ussd.service.spec.ts` (#36/#42 overlap) — resolve in numerical PR order; (5) the C3 unbacked-voucher-issuance question (issuance vs float/programme backing) is not separately closed by this set and stays on the ledger-hardening track.

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

Re-measured 2026-08-16 during the Stage 21 assurance audit, on the audit branch (main @ `324dea5` + migration 041 and its structural spec), after `npm ci`:

- Typecheck (all workspaces): passed
- ESLint (all workspaces, incl. jsx-a11y gap rules): passed
- Migration lint (`lint:sql`, pgsql-ast-parser): 41 migration files, all statements parsed, PK/DROP/TRUNCATE guards passed
- API tests: **2,463 passed, 91 skipped** (2,554 cases in 214 spec files; the 91 skips are the pg-gated contract suites in 4 files — `test/pg/pg-repositories.spec.ts`, `sync.pg.spec.ts`, `traceability.pg.spec.ts`, `voice.pg.spec.ts` — gated by `describe.skipIf(!process.env.DATABASE_URL)`)
- Web tests: **440 passed** (57 files)
- Shared package tests: **30 passed** (5 files)
- SDK tests: **18 passed** (1 file)
- Mobile tests: **150 passed** (22 files)
- **Total automated tests: 3,101 passed + 91 pg-gated skipped** (includes the 6 structural tests added with migration 041; main @ `324dea5` alone measures 3,095 + 91)
- `npm run test --workspaces` aggregate exit code: 0
- Next.js production build: passed; bundle budget gate (`scripts/check-bundle-budget.mjs`, < 250KB gzip shell): **passed at 224.5KB gzip-estimated** (route `/`, 13 JS files — measured locally 2026-08-16; the previously quoted 204.7KB dated from Stage 10)
- Heuristic secret sweep (targeted grep for live-key patterns across tracked files, excluding scanner definitions and labelled test dummies): no real or real-looking secrets found; zero tracked `.env`/key files

Methodology notes: test counts are **runtime counts** from the vitest runs above (not static grep floors); migration count from `ls infra/postgres/*.sql`; web route count (61) from `find apps/web/app -name page.tsx`; repository-provider count (171) from `grep -rE "provide:\s*[A-Z_]+_REPOSITORY" apps/api/src` excluding spec files; mocked-fetch integration tests (188 cases in 20 files) from spec files under `apps/api/src/modules/integrations` that stub `fetch`.

Docker, Docker Compose, Kubernetes, and external provider calls were not executed in this environment because the container runtime is unavailable. Dockerfiles, Compose, and Kubernetes probes were statically aligned with the verified production start command and `/api/v1/health` endpoints. Those items remain staging-verification tasks rather than locally proven evidence.

The operations-hardening wave (hardened workflows, kustomize overlays, backup/restore scripts and CronJob, runbooks, digest-pinning policy) was validated statically in the same environment: `bash -n` syntax checks on all scripts and YAML parse checks on every workflow and manifest. Container builds, Trivy scans, gitleaks, and cluster applies execute on GitHub-hosted runners once the repository is pushed; cluster-dependent deploy steps skip with an explicit notice until environment credentials are provisioned.

## 9. Final handoff statement

AgricPlatform is a coherent, validated monorepo that converts PRD v3.3 into an executable Phase 1 reference architecture. It is intentionally honest about boundaries: local stubs make the code deterministic, adapter interfaces preserve the production migration path, and all legal, regulatory, credential, uptime, and live-provider gates remain explicit. The correct next step is controlled staging hardening, not public launch.
