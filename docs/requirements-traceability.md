# Requirements Traceability — AgricPlatform

This matrix traces PRD v3.3 requirements (18 modules, epics E1–E10, four canonical journeys, NFR categories) to the AgricPlatform implementation plan and records the acceptance evidence required before each item can be called done. It is the acceptance backbone for release gates R1, R2 and R3.

## Baseline and status taxonomy

**Repository baseline:** this matrix was initially written against the specification baseline (SPEC.md, `packages/shared` domain contracts, `.env.example` driver flags) before the runtime implementation landed. **Updated on 2026-08-02:** `apps/web`, `apps/api`, and `infra` now exist and are validated; the current implementation state and launch score are maintained in `docs/production-readiness.md`. The status column below preserves the original planning classification so PRD scope and phase intent remain traceable; do not read historical labels such as "contracts only" as the current repository state.

**Status classifications used throughout:**

| Status | Meaning |
| --- | --- |
| Implemented reference slice | Behaviour exists as runnable code in the repository today (shared contracts, scoring logic, tests) and is verifiable without credentials. |
| Adapter-ready | The integration point is specified as a provider adapter with a local stub (SPEC contract 4, `.env.example` `*_DRIVER` flags); stub behaviour is code-verifiable, but the live provider path cannot be exercised without credentials. |
| External dependency | Delivery is gated on a third party: signed agreement, issued credentials, regulatory review, or partner system access. Code alone cannot close it. |
| Phase 2 | Committed to Phase 2 per PRD Ch. 7.1 priority table and the GitHub milestone plan; out of Phase 1 acceptance scope. |
| Phase 3 | Committed to Phase 3 (Appendix A target architecture scope); out of Phase 1/2 acceptance scope. |

**Implementation surface key:** `web` = `apps/web` (Next.js PWA), `api` = `apps/api` (NestJS modular API), `infra` = local stack, deployment and CI assets, `docs` = repository documentation.

---

## 1. Module traceability (M1–M18)

| # | Module (PRD Ch. 7) | MVP scope per PRD | Phase / release | Implementation surface | Acceptance evidence expected | Initial planning status |
| --- | --- | --- | --- | --- | --- | --- |
| M1 | Identity & Onboarding | Role signup, phone OTP, location capture, progressive profile, completion score | Phase 1 / R1 (Epic E1) | web: signup/onboarding flows; api: auth, users, profiles modules; infra: Keycloak realm config; docs: this matrix | Role/OTP auth E2E against Keycloak; state/LGA seed data; profile completion score unit + API tests; consent capture record on registration | Implemented reference slice (roles, KYC tiers, location types, completion scoring in `packages/shared`); OTP/Keycloak path is Adapter-ready |
| M2 | Personalized Dashboards | Role dashboards with key widgets (farmer, chapter lead, buyer, partner, admin) | Phase 1 / R1–R2 (Epic E2) | web: role-aware dashboard pages; api: dashboard aggregation module | Widget render tests per role; RBAC-filtered dashboard API tests; p95 < 500 ms on dashboard endpoints in staging | Phase 1 planned; contracts only at baseline (roles in `packages/shared`) |
| M3 | Community & Engagement | Forums, groups, messaging, events calendar, moderation | Phase 1 / R1 (Epic E4) | web: forum/group UI; api: community module + Discourse bridge adapter; infra: Discourse deployment | Discourse SSO login E2E (sandbox); group/category sync test; moderation queue workflow test | Adapter-ready (`COMMUNITY_DRIVER=stub` default); live Discourse is External dependency (hosting + SSO keys) |
| M4 | Learning Academy (NYFN University) | 5–10 seed courses, basic LMS, enrolment, progress, certificates | Phase 1 / R1 (Epic E3) | web: catalogue/course UI; api: learning module + Moodle bridge; infra: Moodle deployment | Enrolment → completion → certificate flow test; certificate verification code check; Moodle completion webhook test (sandbox) | Adapter-ready (`LMS_DRIVER=stub`); live Moodle is External dependency |
| M5 | Advisory & Decision Support | Crop calendar, pest advisory, weather alerts | Phase 1 / R2 (Epic E7) | web: advisory pages; api: advisory module + weather/price feed adapters; docs: content sourcing notes | Crop calendar renders by zone/crop; weather alert adapter test against recorded NiMet/OpenMeteo payload; FEWS NET snapshot ingestion test | Adapter-ready (`WEATHER_DRIVER=stub`); NiMet feed is External dependency; OpenMeteo is verifiable without credentials |
| M6 | Opportunity Marketplace | Directory, applications, status notifications | Phase 1 / R2 (Epic E5) | web: directory + application UI; api: opportunities module | Application lifecycle test across `APPLICATION_STATUSES` (shared contract); eligibility pre-screen test; matching-alert trigger test | Implemented reference slice (application status contract); full slice Phase 1 planned |
| M7 | Produce Marketplace & Route-to-Market | Listings, buyer-seller matching, order tracking, escrow-ready payments | Phase 2 per PRD 7.1 (Journey 2 reference slice planned earlier) | web: listing/order UI; api: marketplace module; api: payments adapter | Order state machine test across `ORDER_STATUSES`; escrow-state transition test with payment stub; dispute path test | Implemented reference slice (order status contract); payments Adapter-ready; escrow via Paystack is External dependency; full module Phase 2 |
| M8 | Input & Service Marketplace | Supplier directory, service bookings, reviews | Phase 2 | web: directory/booking UI; api: marketplace module extension | Supplier directory CRUD + search test; booking workflow test; verified-buyer review test | Phase 2 |
| M9 | Finance & Credit Readiness | Credit profile, document vault, opportunity matching, KYC tiers | Phase 2 per PRD 7.1 (foundations in Phase 1 journeys J1/J4) | web: credit profile/vault UI; api: finance module; infra: object storage for documents | Credit-readiness score test; document vault upload/access-control test; KYC tier gating test (`KYC_TIERS` contract); double-entry ledger posting test | Implemented reference slice (KYC tier contract); BVN/NIN verification is External dependency (NIBSS/NIMC agreements); full module Phase 2 |
| M10 | Chapter & Field Operations | Four-level hierarchy, rosters, events, QR attendance, announcements | Phase 1 / R2 (Epic E6) | web: chapter management + QR check-in UI; api: chapters module | Hierarchy (National→State→LGA→Ward) integrity test; QR attendance recording test incl. duplicate-scan rejection; chapter KPI aggregation test | Phase 1 planned; contracts only at baseline |
| M11 | Women & Youth Programmes | Programme pages, cohorts, enrolment, impact tracking | Phase 2 (Journey 4 exercises admin/programme slice in Phase 1) | web: programme portal; api: opportunities/programmes + partner modules | Cohort enrolment test; per-programme impact metric test; protected-space access test | Phase 2 |
| M12 | Student & NYSC | NYSC enrolment, campus club registration | Phase 2 | web: student pathways UI; api: programmes/chapters extension | NYSC pathway enrolment test; campus club registration and approval test | Phase 2 |
| M13 | Data, Analytics & Reporting | Admin analytics, key platform KPIs, exports | Phase 1 basic / R3 (Epic E9); full Phase 2–3 | web: analytics dashboards; api: analytics module; infra: BI tool (Superset/Metabase) optional | KPI query tests against seeded fixtures; CSV/PDF export test; segmentation query test | Phase 1 planned (basic); lakehouse/advanced analytics Phase 3 |
| M14 | Knowledge Base, Media & Events | Resource library, podcast integration | Phase 2 per PRD 7.1 | web: library UI; api: content module + Directus adapter | Directus content sync test (sandbox); tagged search test; media embed render test | Adapter-ready via CMS adapter (no dedicated driver flag yet); live Directus is External dependency; full module Phase 2 |
| M15 | Notifications & Communication | SMS, push, in-app; WhatsApp and email adapters; preferences | Phase 1 / R2 (Epic E8) | web: notification centre + preferences UI; api: notifications module; adapters for Termii/Twilio, 360dialog, Mailgun/SendGrid, OneSignal | Preference matrix test across `NOTIFICATION_CHANNELS` contract; delivery-log write test per channel; stub driver send tests | Implemented reference slice (channel contract); all four drivers Adapter-ready (`SMS/WHATSAPP/EMAIL/PUSH_DRIVER=stub`); live sends are External dependency |
| M16 | Search, Discovery & Recommendations | Basic search and filters; AI recs later | Phase 1 basic; recommendations Phase 3 | web: search UI; api: search module + Meilisearch adapter | Full-text search test across content/users/opportunities/listings/courses with stub/local engine; faceted filter test | Adapter-ready (`SEARCH_DRIVER=stub`); Meilisearch self-host verifiable in local stack; recommendation engine Phase 3 |
| M17 | Admin, CRM & Partner Workflows | User management, review queues, audit logs; partner workspace | Phase 1 / R3 (Epics E9, E10) | web: admin console + partner workspace; api: admin, partner modules | User approve/suspend/verify flow test; review queue approve/reject test with notes; audit entry emitted per admin action; partner scoped-access test | Phase 1 planned; audit/contract scaffolding only at baseline |
| M18 | Security, Compliance & Integrations | RBAC, encryption, NDPR consent, Paystack integration, provider adapters | Phase 1 / R1–R3 (cross-cutting) | api: guards, interceptors, privacy module; infra: TLS, secrets, WAF, backups; docs: `docs/security-compliance.md`, `docs/integration-matrix.md` | See `docs/security-compliance.md` §verification matrix: RBAC guard tests, idempotency replay test, consent log test, export/delete E2E, secret scan clean, backup restore drill | Implemented reference slice (RBAC role contract, driver flags, docs); encryption-at-rest/WAF/backups are infra-provisioning dependent; pen test and DPO are External dependency |

## 2. Epic traceability (E1–E10, PRD Ch. 13)

| Epic | Name | Release | Modules | User stories (PRD) | Journeys exercised | Acceptance evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | Member Identity & Onboarding | R1 (3 sprints) | M1, M2, M18 | US-E1-01 … US-E1-05 | J1 (steps 1–3) | Keycloak-backed signup/login E2E; role assignment test; profile completion scoring test (exists: `packages/shared/test/profile.test.ts`); session/logout test | Implemented reference slice (scoring + role contract); OTP path Adapter-ready |
| E2 | Role-Based Dashboards | R1 & R2 (2 sprints) | M2, M13 | US-E2-01 … US-E2-03 | J1, J3, J4 | Per-role widget tests; RBAC filtering test; dashboard performance check | Phase 1 planned |
| E3 | Learning Academy | R1 (3 sprints) | M4, M15 | US-E3-01 … US-E3-04 | J1 (steps 5–6), J4 | Enrol/complete/certificate E2E; Moodle bridge webhook test (sandbox); certificate-to-credit-profile event test (`learning.certificate.issued`) | Adapter-ready (Moodle stub) |
| E4 | Community Forum | R1 (2 sprints) | M3, M18 | US-E4-01 … US-E4-03 | J3 (recruitment comms) | Discourse SSO E2E (sandbox); post/moderate flow test; report/flag queue test | Adapter-ready (Discourse stub) |
| E5 | Opportunity Directory | R2 (2 sprints) | M6, M15 | US-E5-01 … US-E5-03 | J1 (steps 7–10) | Directory search/filter test; application submission test with idempotency key; status notification test | Phase 1 planned; status contract implemented |
| E6 | Chapter Operations | R2 (3 sprints) | M10, M15 | US-E6-01 … US-E6-03 | J3 (all steps) | Chapter CRUD + roster test; event + RSVP test; QR attendance test; chapter report submission test | Phase 1 planned |
| E7 | Advisory & Knowledge Base | R2 (2 sprints) | M5, M14 | Not enumerated in PRD 13.2 | J1 (advisory touchpoints) | Crop calendar by zone test; weather alert adapter test; content library render test | Adapter-ready (weather stub) |
| E8 | Notifications & Engagement | R2 (1 sprint) | M15 | Not enumerated in PRD 13.2 | J1–J4 (all notification steps) | Channel preference test; delivery log test; SMS/push/in-app stub send tests; template rendering test | Adapter-ready (all four drivers stubbed) |
| E9 | Admin Panel & Analytics | R3 (2 sprints) | M17, M13 | US-E9-01, US-E9-02 | J4 (steps 2, 4, 8) | Admin user-management flow test; KPI dashboard test against seeded metrics; audit trail test | Phase 1 planned |
| E10 | Partner Workspace (Basic) | R3 (2 sprints) | M17, M11 | Not enumerated in PRD 13.2 | J4 (steps 3, 9) | Partner-scoped token/role test; post-opportunity flow test; read-only impact dashboard test | Phase 1 planned |

## 3. Canonical journey traceability (PRD Ch. 9)

| Journey | Modules spanned | Key external systems | Acceptance evidence (QA scenario) | Status |
| --- | --- | --- | --- | --- |
| J1 — Registration to opportunity application | M1, M2, M4, M6, M9, M15, M17 | Keycloak, Termii (OTP), Moodle, Paystack n/a, WhatsApp (alert) | Scripted E2E: signup → OTP (stub/sandbox) → profile → course enrol → certificate → matching alert → vault upload → application in admin review queue | Reference-sliceable end-to-end with stub drivers; OTP/WhatsApp live steps are External dependency |
| J2 — Produce listing to buyer order and escrow-ready settlement | M7, M2, M15, M16, M10, M18 | Paystack (escrow), WhatsApp, search engine | E2E: listing → search indexing → buyer request → negotiation → deposit (payment stub/sandbox) → delivery confirmation → balance release state → reviews | Order status contract implemented; escrow settlement cannot be live-verified without Paystack live keys — External dependency; full marketplace Phase 2 |
| J3 — Chapter setup, recruitment, event, attendance, reporting | M10, M2, M15, M13 | Termii, WhatsApp (invites), push | E2E: chapter wizard → 50 invites (stub) → roster updates → event create → RSVP → QR check-in ×19 → activity report → national analytics row | Phase 1 planned; invite delivery live-verification is External dependency |
| J4 — Admin programme creation, enrolment, impact reporting, partner visibility | M17, M11, M4, M10, M13, M15 | WhatsApp (targeted alerts), email, BI export | E2E: programme create → targeted notify (stub) → 450 applications → approval queue → enrol 200 → completion aggregation → CSV/PDF export → partner read-only dashboard | Phase 1 planned (R3); partner workspace is Epic E10 |

## 4. NFR category traceability (PRD Ch. 8)

| NFR category | Requirement (PRD) | Implementation surface | Verification method | Status |
| --- | --- | --- | --- | --- |
| Performance | Page < 3 s on 3G (~1 Mbps); API p95 < 500 ms; SSR first paint | web (SSR, bundle budget), api (query tuning) | Lighthouse CI on 3G throttle; k6 p95 gate in CI/staging | Phase 1 planned |
| Availability | 99.5% rolling 30-day; maintenance 01:00–04:00 WAT with 48 h notice; 2 h incident response | infra | Uptime monitor (Grafana/Betteruptime) 60-day evidence for Phase 1 gate | External dependency (hosting provisioned) |
| Scalability | Horizontal scaling to 1M+ members; connection pooling; Redis cache; stateless containers | api, infra | Stateless API container test; load test at target concurrency | Phase 1 design; Phase 2/3 proof |
| Mobile-first & offline | Installable PWA; offline registration, course access, opportunity browsing, produce listing via service workers + IndexedDB | web | PWA install audit; offline E2E for the four critical journeys with sync-on-reconnect | Phase 1 planned |
| Accessibility | WCAG 2.1 AA: 4.5:1 contrast, keyboard nav, ARIA, alt text, transcripts | web | axe-core CI gate; manual keyboard/screen-reader pass per release | Phase 1 planned |
| Localisation | English, Hausa, Yoruba, Igbo; externalised strings; professional translation of agronomy content | web, docs | i18n coverage report (no hard-coded strings); language switch test | Implemented reference slice (`LANGUAGE_CODES` contract en/ha/yo/ig); translations External dependency (professional translators) |
| Data residency | PII in Nigeria/West Africa region (AWS af-south-1 or equivalent); no PII stored exclusively outside Africa without consent | infra, docs | Region evidence from cloud account; residency statement in privacy policy | External dependency (cloud provisioning + legal) |
| Security | OWASP Top 10 mitigations; third-party pen test pre-launch and annually | api, web, infra, docs | See `docs/security-compliance.md` §OWASP mapping; pen test report | Controls Phase 1 planned; pen test External dependency |
| Backup & recovery | Daily automated backups day one; RTO < 4 h; RPO < 1 h; monthly integrity test | infra | Backup schedule config; quarterly restore drill record | External dependency (environment provisioning) |
| Low-bandwidth optimisation | WebP responsive images, lazy loading, gzip/brotli, inlined critical CSS, ≤ 300 KB first load | web, infra (CDN) | Bundle/page-weight budget check in CI | Phase 1 planned |
| Privacy & NDPR | Consent at registration; privacy dashboard (view/edit/export/delete); processing register; appointed DPO | web, api (privacy module), docs | Consent log test; export/delete E2E; register document; DPO appointment letter | Consent/export/delete design Phase 1; DPO appointment External dependency (legal) |

## 5. Phase mapping summary

| Phase / release | Timeframe (PRD) | Modules / epics in scope | Gate evidence |
| --- | --- | --- | --- |
| R1 Alpha (Phase 1, months 1–4) | Gate 1: internal alpha, month 5, 50 NYFN staff/chapter leads | M1, M2, M3, M4 (E1–E4); M18 cross-cutting | CI green; Keycloak login E2E; learning + community slices demo |
| R2 Beta (Phase 1, months 5–7) | Gate 2: closed beta, 500 invited users, 5 pilot states | M5, M6, M10, M15 (E5–E8); E2 completion | Journey J1, J3 QA scripts pass on staging with stub/sandbox drivers |
| R3 Public Launch (Phase 1, months 7–8) | Gate 3: open registration | M13 basic, M17 (E9, E10); security hardening | Phase 1 gate checklist (Appendix D.5): pen test resolved, DPO appointed, privacy policy + ToS published, uptime > 99% for 60 days |
| Phase 2 | Post-launch | M7, M8, M9, M11, M12, M14, M16 (full), M17 (full); WhatsApp structured replies; mobile app; TigerBeetle/Mojaloop/Temporal adapters | Phase 2 gate checklist: 100+ marketplace transactions/30 days, escrow QA-approved, ⚖ legal items cleared (see security-compliance doc) |
| Phase 3 | Later | Recommendations, lakehouse analytics, USSD/IVR, commodity exchange (NCX/AFEX) ACL, farmOS sync, public SDK | Phase 3 gate checklist incl. ⚖ exchange/WRS/data-licensing legal reviews |

## 6. Stage 8 implementation-status addendum (2026-08-02, full-production push)

The table below supersedes the "Initial planning status" column wherever they disagree. Waves: P1 provider adapters (merge 5f6a08f), P2a commerce/finance (19fd7ad), P2b engagement modules (e0994e5), P3 NFR tooling (805ffb7), P4 frontend wiring (wave-p4-frontend). Merged-main validation: 412 API + 17 shared + 68 web tests green, lint:sql 6 migration files, typecheck/lint/build green.

| Item | Post-Stage-8 status |
| --- | --- |
| M5 Advisory | OpenMeteo weather is the LIVE default (keyless, 37-state Nigeria centroid table, 15-min Redis cache, wired into advisory weather path). FEWS NET/NiMet ingestion scaffold implemented (gated on `MARKET_DATA_DRIVER` + feed keys) persisting to `advisory.commodity_prices` (migration 006). NiMet live feed remains External dependency. |
| M7 Produce Marketplace (full) | Escrow state machine (HELD→RELEASED/REFUNDED/DISPUTED + admin dispute resolution, audit-logged), invoicing (per-seller sequence, VAT 7.5%, integer-kobo), logistics (PICKUP_SCHEDULED→…→CONFIRMED; delivery-confirm releases escrow). `PAYMENT_PROVIDER` port; Paystack/Flutterwave drivers implemented (P1) incl. refund/transfer/escrow-release + webhook signature verification. Live settlement External dependency. |
| M8 Input & Service Marketplace | Implemented (services-marketplace module): supplier directory (7 categories), offerings, booking state machine with date-window conflict checks, one-review-per-completed-booking + supplier aggregate. 004 migration. |
| M9 Finance & Credit (full) | Double-entry ledger runtime (≥2 balanced postings invariant in service, integer kobo, reversal-via-counter-entry, idempotency-key replay), deterministic credit scoring, lender directory + matching, loan workflow state machine, equal-installment repayment calendar (exact BigInt amortisation) with mark-paid postings. 003 migration. BVN/NIN verification External dependency. |
| M10 Chapter Ops | QR attendance implemented: HMAC-SHA256 signed rotating codes (15-min window + grace), scan endpoint, duplicate member+event → 409, fail-closed signing secret in production. 005 migration. |
| M11 Women & Youth | Implemented (programmes module): cohort lifecycle, eligibility-gated enrolment, milestones + progress, judging (rubric, unique judge+entry+criterion scores, leaderboard), protected spaces with tested denial paths. |
| M12 Student & NYSC | Implemented (pathways module): STUDENT/NYSC templates with evidence-required stage progression, campus clubs with coordinator roster + NYSC CDS flag. |
| M13 Analytics | CSV (RFC 4180) + PDF (pdfkit) exports, admin-guarded, audit-logged (`GET /analytics/export?format=`). Lakehouse/advanced analytics remain Phase 3. |
| M14 Knowledge Base | Implemented (knowledge module): resource library (tags/language/format/offline flag, view counts), podcast episodes with transcript attach, webinars (Africa/Lagos TZ validation, registrations, post-event recording). Directus live sync External dependency. |
| M15 Notifications | Live drivers implemented fail-closed (P1): Termii SMS + Twilio failover, 360dialog WhatsApp (+inbound normalisation), Mailgun + SendGrid, OneSignal. Stub default preserved; production boot throws without credentials. Live delivery-rate evidence External dependency. |
| M16 Search | Trending queries (7-day window, 2-day half-life decay) + related items (tag co-occurrence) implemented; `SEARCH_PROVIDER` port; Meilisearch driver implemented (P1). AI recommendations Phase 3. |
| M18 Security/Integrations | Idempotency hardened (body-mismatch 409 + replay envelopes, Redis 24h TTL). Moodle/Discourse/Directus fail-closed bridge clients (P1). Pen test/DPO remain External dependency. |
| Appendix F (P1 rows) | Idempotency ✓; bundle budget gate ✓ (CI script, verified 202.4KB < 250KB); WebP/lazy-load audit ✓ (`npm run audit:media`); IndexedDB form persistence + data-usage indicator + offline packs → wave P4 (in flight); USSD live on Africa's Talking External dependency. |
| Appendix G | Integration ACL principle realised via the adapter/port layer (no raw external calls in business logic); OpenAPI-versioned `/api/v1` surface; price/weather feeds row (G.3 P1) implemented as above. Partner API onboarding, SDK publish, embedded widgets remain Phase 2/3 + External dependency. |
| NFR tooling | k6 smoke/gate scripts (p95<500 threshold), Lighthouse CI config (mobile 3G, a11y≥0.95 error gate), bundle-budget CI gate, media audit — all in repo; execution against staging/live URLs is environment-dependent. |

## 7. Stage 9 closure addendum (2026-08-02, remaining-scope build-out)

Waves P5a–P5e (merges through c4ebae2) closed every engineering-buildable PRD item that remained after Stage 8. Merged-main validation: 889 tests (711 API + 130 web + 18 SDK + 17 shared + 13 mobile), lint:sql 10 migrations, typecheck/lint/build/bundle green.

| PRD item | Post-Stage-9 status |
| --- | --- |
| M13 full (analytics) | Segmentation, registration/chapter funnels, weekly cohort retention (Africa/Lagos), KPI data marts + idempotent ETL snapshots + columnar CSV export (lakehouse handoff layer). BI tool itself remains an external product choice. |
| M16 full (recommendations) | Explainable content-based recommender with reason codes, cold-start trending fallback, Beta-smoothed feedback loop; `/recommendations` + `/similar` + `/feedback` endpoints. |
| Appendix F channels | USSD fully implemented (Africa's Talking callback, menu state machine: registration, price check, opportunities, course confirmation; 182-char turns, session TTL, idempotent replay). WhatsApp structured multi-turn workflows implemented. Shared-device PIN session swap implemented. Live USSD/SMS carrier testing remains External dependency. |
| Appendix G integrations | farmOS/LiteFarm, OFN, NCX/AFEX, ODK/KoboToolbox, input-finance, e-Extension adapters all implemented fail-closed with consent gating (migration 007). Partner API (client credentials, scoped reads/writes, HMAC webhooks, rate buckets) implemented (migration 010). Developer SDK (`@agric-platform/sdk`) + developer portal + 4 embedded widgets implemented. SDK npm/PyPI publish and partner adoption remain External dependency. |
| Mobile app (Phase 2) | `apps/mobile` Expo/React Native shell with typed API client, offline queue, Login/Home/Courses/Marketplace/Profile screens, CI job. Store assets/submission remain External dependency. |
| IVR (Phase 3) | **Built in Stage 10 (wave P6a)** — see §7a. Live carrier provisioning remains External dependency. |

## 7a. Stage 10 closure addendum (2026-08-02, gap closure + architecture)

Waves P6a–P6c (merges through bf79a21) closed every remaining engineering-doable gap. Merged-main validation: 993 tests (787 API + 158 web + 18 shared + 17 SDK + 13 mobile; 51 pg-gated skips), lint:sql 11 migrations, typecheck/lint/build/bundle (204.7KB < 250KB) green.

| PRD item | Post-Stage-10 status |
| --- | --- |
| IVR (Phase 3, Appendix F) | **Implemented.** Africa's Talking Voice webhook (`POST /api/v1/ivr/callback`, form-encoded → `text/xml`), pure call-flow engine mirroring the USSD menu map (price check, advisory, registration status, course enrolment status, repeat/escalate, 3-strike END), terminal-turn idempotent replay, 10-min call TTL + sweeper, fail-closed production gating. Migration 011 (`channels.ivr_calls`). 50 tests. Live telephony provisioning, call-centre Dial number, and professional voice recordings remain External dependency. |
| Residual hardening (P6b, 7 items) | Redis sliding-window partner rate bucket; partner farm-data pushes persisted (farm_records / pending-link ledger); real ssh2 SFTP transport (fail-closed, env-gated); USSD HTTP e2e; WhatsApp listing LGA capture; duplicate lint key removed; trending-query cold-start blend (`trending_query` reason). 28 tests. |
| Frontend surfaces (P6c, 6 items) | Recommendations rail on `/dashboard`; `/admin/insights` (segmentation, funnels, retention heatmap, mart snapshots + CSV); `/admin/integrations` (links/revoke, sync, staged-import merge, channel status); camera QR check-in (getUserMedia + jsQR with paste fallback); `/knowledge` "My registrations"; axe a11y gate. 28 web tests. |

**Result:** every PRD v3.3 feature area (M1–M18, Appendix E/F/G) now has implemented, test-evidenced code. Remaining open items are exclusively External dependency class (credentials, legal review, pen test, uptime evidence, translations, partner adoption, store submission, telephony provisioning).

## 8. Verification rules

1. **Code-complete evidence** (unit/integration/E2E tests, CI checks, Lighthouse, axe, k6) must pass in CI or staging without third-party credentials, using stub drivers. This is the only evidence class available at the current baseline.
2. **Sandbox evidence** requires test credentials (e.g., Paystack test keys, Moodle sandbox, Discourse staging). It verifies the adapter contract, not production behaviour, and must be labelled `sandbox` in test reports.
3. **Live evidence** requires production credentials and/or signed agreements (Termii, 360dialog, Paystack live, NIBSS BVN, FMARD/AFEX/NCX). Items requiring live evidence are classified **External dependency** and cannot be closed by engineering alone.
4. No module may be reported as "done" for a release gate while any in-scope row above is External dependency and unevidenced; such items must appear on the launch-blocker list in `docs/security-compliance.md`.
