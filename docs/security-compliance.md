# Security & Compliance — AgricPlatform

This document defines the security and compliance control set for AgricPlatform, its verification method, and its launch-blocking status. It implements PRD v3.3 Chapter 8 (NFRs), Chapter 12.6 (Security Controls & Rollout), Module 18, and the Appendix C/D financial and legal gates, against the Phase 1 stack committed in SPEC.md (Next.js, NestJS, PostgreSQL, Redis, Keycloak OIDC).

**Baseline honesty note:** this control matrix was first drafted at the specification baseline. **Updated on 2026-08-02:** the repository now includes the Next.js PWA, NestJS modular API, RBAC/idempotency/audit/privacy reference slices, tests, and deployment assets. Controls below are marked **[code]** where behaviour is or will be verifiable in this repository without credentials, **[infra]** where they depend on environment provisioning, and **[external]** where they require a third party (auditor, regulator, counsel, provider). Nothing marked [external] can be closed by engineering alone. See `docs/production-readiness.md` for the current go/no-go assessment.

## 1. RBAC

- Roles (canonical, in `packages/shared/src/domain.ts`): `farmer`, `student`, `buyer`, `supplier`, `chapter_lead`, `partner`, `admin`. PRD Appendix A also names platform-internal role mappings (e.g., CHAPTER_ADMIN, PROGRAMME_ADMIN, PLATFORM_ADMIN, PARTNER_API) which resolve to these canonical roles at the API boundary.
- Enforcement model [code]: Keycloak issues OIDC tokens carrying realm roles; NestJS guards enforce RBAC from the JWT on every route without round-tripping to the auth server (PRD 12.2); the web app mirrors role visibility in UI but never relies on UI hiding as a control.
- Acceptance evidence: guard unit tests per role per sensitive route; negative tests (farmer token against admin/partner routes returns 403); partner workspace tokens are permission-scoped (M17/E10); two-approval CODEOWNERS rule on `auth` and shared contracts per `docs/github-strategy.md`.
- Status: role contract [code] implemented; API guard layer verifies Keycloak OIDC JWTs via JWKS with bearer-first, header-fallback-outside-production semantics [code]; Keycloak realm hosting [infra]; SSO to Moodle/Discourse [external: hosting].

## 2. Idempotency

- Contract (SPEC 3): every mutating route that can be retried accepts an idempotency key; Redis stores keys with the response fingerprint; replays return the original result without re-executing side effects.
- Financial operations carry a unique idempotency key by default (Appendix C "Idempotency by Default"): payment initiation, escrow transitions, ledger postings, payout triggers.
- Acceptance evidence [code]: replay test submitting the same key twice returns one record and one side effect; concurrent duplicate submission test; key-expiry/TTL test; order state machine (`ORDER_STATUSES`) rejects invalid transitions under retry.
- Status: contract documented and status enums implemented; middleware/guard implementation planned for `apps/api` [code]; Redis-backed store [infra].

## 3. Audit

- Audit log required for admin and sensitive operations (SPEC, M17 MVP): user approve/suspend/verify, role reassignment, review-queue decisions, payout/ledger actions, consent changes, export/delete requests.
- Domain event outbox uses the `{domain}.{entity}.{verb}` taxonomy (e.g., `identity.user.registered`, `marketplace.order.placed`); Appendix A targets Kafka as the event/audit backbone, with the Phase 1 simplification of an internal event bus (NestJS EventEmitter or Redis Pub/Sub) writing to a Postgres audit/outbox table.
- Acceptance evidence [code]: every admin mutation emits an audit row with actor, action, target, timestamp, before/after digest; outbox write is transactional with the domain write; audit query API test.
- Status: taxonomy documented [code]; emitters planned; Kafka/Wazuh streaming of audit events [external/Phase 2].

## 4. NDPR/NDPA consent

- Consent captured at registration for data collection, processing, and communications (PRD Ch. 8 Privacy); consent records carry timestamp, purpose, source, and revocation (architecture contract).
- Channel-level consent for SMS/WhatsApp/email/push is enforced in notification preferences (`NOTIFICATION_CHANNELS` contract); marketing vs transactional purposes are separate consent flags.
- Consent is enforced before any profile enrichment from external data (Appendix G ACL: "consent enforced before any profile enrichment").
- Acceptance evidence [code]: registration cannot complete without consent record; consent log row per grant/revoke; revocation stops non-essential channel sends (test with stub drivers); processing register document maintained [docs].
- Status: design [code/docs]; DPO appointment and NDPR compliance review [external] — Phase 1 gate item ⚖.

## 5. Data export and deletion

- Privacy dashboard lets users view, edit, export, and request deletion of their data (PRD Ch. 8); privacy module owns consent, export, deletion, and the processing register (architecture).
- Export: machine-readable bundle (JSON/CSV) of profile, applications, orders, documents metadata, learning records, notification logs.
- Deletion: request → verification → grace period → erasure or anonymisation across domains; financial ledger entries are retained as anonymised balances (ledger immutability; Appendix C) with PII stripped; audit trail records the deletion action itself.
- Acceptance evidence [code]: export E2E produces complete bundle for a seeded user; deletion E2E removes/anonymises PII while preserving required financial records; cross-domain check that no domain retains unconsented copies.
- Status: planned [code]; legal review of retention schedule [external] ⚖.

## 6. Secrets management

- No secrets in Git (github-strategy). `.env.example` documents variable names only; all provider keys ship empty. `JWT_SECRET` and `WEBHOOK_SIGNING_SECRET` carry explicit `local-development-only` values.
- Runtime secrets: GitHub Environments for CI; AWS Secrets Manager or equivalent for deployed environments (PRD 12.6). Local development defaults to stub drivers (`*_DRIVER=stub`).
- Acceptance evidence: secret scanning in CI (gitleaks or equivalent) is a required check; dependency audit (Dependabot + npm audit) enabled; rotated-webhook-secret test for Paystack/Termii webhook signature verification. Webhook HMAC-SHA256 verification over the raw body is implemented with idempotent replay handling and a stub-driver development bypass only outside production [code].
- Status: [code] enforced by repo hygiene and CI gate (planned); cloud secret store [infra].

## 7. OWASP Top 10 mapping (PRD 12.6 control table)

| Risk area | Committed control | Evidence | Status |
| --- | --- | --- | --- |
| Broken access control | Keycloak JWT + NestJS guards; negative RBAC tests | Guard tests | [code] planned |
| Cryptographic failures | TLS 1.3 in transit (Cloudflare/HSTS); AES-256 at rest (RDS encryption, S3 SSE, sensitive-column encryption) | TLS scan; infra config review | [infra] |
| Injection | TypeORM parameterised queries only; class-validator on all DTOs; Zod on frontend forms | DTO validation tests; lint rule banning raw SQL | [code] planned |
| Insecure design | Ports/adapters, ACL boundaries, idempotency, double-entry ledger | ADR/architecture review | [docs] done at baseline |
| Security misconfiguration | Cloudflare WAF (OWASP Core Rule Set); hardened headers; environment parity | Config review; header tests | [infra] |
| Vulnerable components | Dependabot + npm audit in CI | CI gate output | [code] planned |
| Auth failures | Keycloak phone-OTP SPI (Termii), MFA option, stricter rate limits on auth endpoints; OTP attempt lockout + no dev code in production | OTP lockout/expiry tests; throttler test | [code] implemented /[external: Termii SPI] |
| Software/data integrity | Branch protection, required CI, signed releases, linear history | GitHub settings evidence | [code] planned |
| Logging/monitoring failures | Audit log + delivery logs; Wazuh/OpenSearch SOC (Phase 2) | Audit tests; SOC runbook | [code] Phase 1 / [external] Phase 2 |
| SSRF / rate abuse | NestJS Throttler (in-memory now, Redis-backed follow-up), stricter on auth; APISIX rate limiting at edge (target) | Throttler tests | [code] implemented (Redis follow-up) |
| **Penetration test** | Third-party test before public launch and annually thereafter | Pen test report; critical findings resolved | **[external] — launch blocker** |

## 8. Backups and disaster recovery

- Requirements (PRD Ch. 8): automated daily backups of all databases and file stores from day one; RTO < 4 hours; RPO < 1 hour; backup integrity tested monthly.
- Scope: PostgreSQL (point-in-time recovery to satisfy RPO < 1 h), Redis (no durable user data — idempotency keys are reconstructible), document vault object storage (versioned bucket + cross-region copy), Keycloak realm export.
- DR: `dr` standby environment per github-strategy once cloud infrastructure is provisioned; restore runbook and quarterly restore drill.
- Acceptance evidence: backup schedule configuration; timed restore drill records (RTO proof); monthly integrity check log.
- Status: [infra]/[external: cloud provisioning] — Phase 1 gate dependency (uptime > 99% for 60 days also requires provisioned monitoring).

## 9. Data residency

- PII stored in Nigeria or West African region (AWS af-south-1 or equivalent); no Nigerian PII stored exclusively outside Africa without explicit consent (PRD Ch. 8, NDPR alignment).
- Consequences: database, object storage, backups, and log sinks must be region-pinned; sub-processors (email/SMS/push providers) must be listed in the privacy policy with transfer basis.
- Acceptance evidence: cloud region configuration; sub-processor register [docs]; residency clause in privacy policy.
- Status: [external: cloud + legal].

## 10. Financial controls

Positioning (Appendix C.1): **the platform is not a bank.** It never holds regulated customer funds in an unlicensed capacity, never originates loans on its own balance sheet, and never transmits payment instructions outside a regulated partner (Paystack, Flutterwave, or a Mojaloop-connected bank).

- **Ledger:** Phase 1 simplification is a double-entry ledger in PostgreSQL (accounts + transfers tables) with a storage-agnostic ledger interface, so TigerBeetle can replace it in Phase 2 (Appendix A.15). Acceptance [code]: every transfer posts balanced debit/credit entries; ledger is append-only (no updates/deletes); reconciliation report balances to zero.
- **Escrow:** marketplace deposits use Paystack escrow/split payments via a licensed PSSP; the platform records escrow *state* (`deposit_paid` → `delivered` → `completed`) but funds move only through the PSSP. Acceptance: sandbox escrow flow test [sandbox]; live escrow QA per Phase 2 gate [external].
- **KYC tiers:** `tier_0`–`tier_3` contract implemented (`KYC_TIERS`); tier progression gates financial features; BVN/NIN verification (NIBSS/NIMC) is Phase 2 [external — commercial agreements required] ⚖.
- **Disclosure:** lender referral relationships disclosed in the lender directory; CBN guidance reviewed by counsel before referral fees activate ⚖.
- **Anti-fraud:** phone uniqueness at Keycloak registration; duplicate-account detection; fraud rules in the finance ACL (Phase 2).
- **Two-approval rule** for finance/payments code changes (github-strategy) [code].

## 11. Legal ⚖ gates (Appendix D.5 commercialization checklist)

Items the PRD marks ⚖ require review by qualified Nigerian counsel before the associated capability activates:

| Gate | Item | Owner per PRD |
| --- | --- | --- |
| Phase 1 | NDPR compliance review completed; Data Protection Officer appointed | NYFN Leadership + Legal |
| Phase 1 | Privacy policy and Terms of Service published (English and Pidgin) | NYFN Legal |
| Phase 2 | Transaction fee rate approved by NYFN board; disclosed in Terms & Conditions | NYFN Board + Legal |
| Phase 2 | KYC Tier 2 BVN integration tested; NIBSS commercial agreement; CBN operational guidelines reviewed | Tech Lead + Legal |
| Phase 2 | Lender referral fee model reviewed against CBN consumer protection regulations | NYFN Legal Advisor |
| Phase 3 | First data licensing agreement reviewed; anonymisation approach validated by independent technical review | Legal + CTO |
| Phase 3 | Warehouse Receipt System design reviewed against CBN WRS guidelines and CAMA provisions | Legal + Partnerships |
| Phase 3 | NCX/AFEX exchange integration API agreement reviewed and signed; trade controls in place | Legal + Tech Lead |

Additional counsel item (Appendix B/C): CBN Consumer Protection Framework and embedded-finance guidance reviewed before lender referral fees; the working assumption that referrals do not require a payments/lending licence must be confirmed by counsel (PRD "CBN Regulatory Note").

## 12. Launch blockers (must be closed before R3 public launch)

| # | Blocker | Class | Evidence to close |
| --- | --- | --- | --- |
| L1 | Third-party penetration test; all critical findings resolved | [external] | Pen test report + remediation sign-off |
| L2 | NDPR compliance review; DPO appointed ⚖ | [external] | Review memo; appointment letter |
| L3 | Privacy policy + ToS published (English and Pidgin) ⚖ | [external] | Published URLs |
| L4 | Production credentials: Termii (OTP SMS), Keycloak hosting, Paystack (live keys for J2 sandbox→live), email provider | [external] | Credentials in secret store; live smoke tests |
| L5 | Uptime > 99% for 60 consecutive days with monitoring evidence | [external/infra] | Grafana/Betteruptime report |
| L6 | Backup schedule live + successful restore drill (RTO < 4 h / RPO < 1 h) | [infra] | Drill record |
| L7 | RBAC negative-test suite green; idempotency replay suite green; audit emission tests green | [code] | CI reports |
| L8 | Consent capture + export/delete E2E green on staging | [code] | QA report |
| L9 | Secret scanning + dependency audit enforced as required CI checks | [code] | Branch protection settings |
| L10 | Phase 1 KPI baseline collected; steering committee sign-off in writing | [external] | Signed gate minute |

Items L1–L6 cannot be satisfied by code in this repository; they are tracked here so no release gate is declared green on engineering evidence alone.

## 13. Verification matrix summary

| Control area | Code-verifiable now/at build | Sandbox-verifiable | Requires credentials/third party |
| --- | --- | --- | --- |
| RBAC | Guard/role tests | Keycloak staging realm | Keycloak production hosting |
| Idempotency | Replay/concurrency tests | — | Redis in production config |
| Audit | Emission/outbox tests | — | Wazuh/OpenSearch SOC (Phase 2) |
| Consent | Consent-log tests | — | DPO/legal review ⚖ |
| Export/delete | E2E on seeded data | — | Retention schedule legal review ⚖ |
| Secrets | Secret scan, audit CI | — | AWS Secrets Manager provisioning |
| OWASP | Validation/throttler tests | — | Penetration test |
| Backups/DR | — | — | Cloud provisioning + drills |
| Residency | — | — | Region-pinned infra + policy |
| Financial controls | Ledger balance/idempotency tests | Paystack escrow sandbox | Paystack live, NIBSS/BVN, CBN counsel ⚖ |
