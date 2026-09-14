# Go-live checklist (Wave OPS)

Ordered human gates for taking the Nigeria Farmer Platform to production.
Every gate is a HUMAN sign-off — scripts verify technical facts, but no
script signs off legal, compliance, or vendor readiness. Record each gate
(owner, date, evidence link) in the launch tracker.

> Nothing in this checklist is evidence by itself. A checked box without a
> recorded owner + date + artifact is an unchecked box.

## Gate 1 — Legal & compliance sign-off

- [ ] NDPR/privacy review approved by counsel (data export + deletion
      flows are implemented — `/privacy/*` endpoints — but counsel must
      approve the policies and consent copy, not the code).
- [ ] Escrow/payments regulatory review (CBN/PSSP arrangements) signed off.
- [ ] Terms of service + farmer-facing agreements finalized.
- [ ] Security posture reviewed against `docs/security-compliance.md`.

**Owner:** legal/compliance lead. **Blocks:** everything below.

## Gate 2 — Credentials in the secret manager

- [ ] All production secrets provisioned in the secret manager (never in
      git, never in CI logs): `DATABASE_URL`, `REDIS_URL`, `OIDC_ISSUER`,
      `OIDC_AUDIENCE`, `ATTENDANCE_SIGNING_SECRET` (≥16 chars, high
      entropy), `VET_SIGNING_SECRET` (≥16 chars), `METRICS_TOKEN`
      (Prometheus scrape credential), `PARTNER_API_SIGNING_SECRET` (if
      partner API goes live), integration driver credentials for every
      non-stub driver (paystack, termii, …).
- [ ] Stage 27 boot-required secrets provisioned when their features are
      enabled: `MSISDN_HASH_SALT`, `AGENT_QR_SECRET`, `CREDIT_PASSPORT_SECRET`,
      and the live-driver secrets (`PARTNER_API_*`, `NIN_*`) — all HMAC-class
      secrets at or above the 32-character boot floor
      (`PRODUCTION_HMAC_SECRET_MIN_LENGTH`, `apps/api/src/config/auth.config.ts`);
      the API refuses to boot on weak values (merge-log, smoke root-cause).
- [ ] Keycloak realm-side config for phone-auth (WP-G16/G17): confidential
      client + `KEYCLOAK_CLIENT_ID`/`KEYCLOAK_CLIENT_SECRET` + supervisor role
      mapping BEFORE setting `PHONE_AUTH_KEYCLOAK=true`
      (`apps/api/.env.example` ~lines 143–154; evidence-pack §4.1).
- [ ] Break-glass flags confirmed UNSET in production:
      `ALLOW_INMEMORY_PERSISTENCE` and `ALLOW_INMEMORY_CACHE` are local-drill
      escape hatches only (`apps/api/src/config/persistence.config.ts:19,37`).
- [ ] Base-image digests pinned in `infra/docker/api.Dockerfile` and
      `web.Dockerfile` per their header policy (registry-verified digests only).
- [ ] Secrets rotated from any value ever used in staging/dev.
- [ ] Access to the secret manager itself is least-privilege and audited
      (`infra/k8s/secrets-provisioning.md`).
- [ ] `.env.example` documents names only — verify no real values crept in.

**Owner:** platform/SRE lead. **Verify:** the API boots (fail-closed
guards refuse to start on missing config).

## Gate 3 — verify:providers green

- [ ] `npm run verify:providers` exits 0 with **zero FAIL lines**, run from
      the production network context (SKIP is acceptable only for
      integrations deliberately left stubbed — record which and why).
- [ ] Output pasted into the launch tracker (it never contains secrets).

**Owner:** SRE + integrations lead. This gate verifies REAL connectivity:
Postgres + migration level, Redis, OIDC discovery + audience, Paystack
balance endpoint, termii balance, weather feed.

## Gate 4 — DR drill executed and recorded

- [ ] At least one production-shaped backup exists (`npm run backup:db`
      output with checksum + manifest).
- [ ] `npm run verify:restore` PASSED against that backup (checksum +
      per-table row counts), result recorded with date and restore
      duration.
- [ ] Backup schedule (nightly CronJob) is actually applied in the
      cluster, and the dead-man monitoring (no new dump in 26 h) is armed.
- [ ] RTO/RPO recommendations in [dr.md](dr.md) accepted by the business
      owner (or adjusted and re-documented).

**Owner:** SRE lead + business owner.

## Gate 5 — Observability armed

- [ ] Prometheus scraping `/api/v1/metrics` with the `METRICS_TOKEN`
      credential (`up{job="agric-api"} == 1`).
- [ ] `infra/observability/alerts.yml` loaded; Alertmanager routes `page`
      severity to the on-call rota; on-call rota staffed.
- [ ] Grafana dashboard `infra/observability/grafana/dashboards/platform.json`
      imported and showing live data.
- [ ] Sentry DSN configured (or explicitly deferred) with `beforeSend`
      scrubbing confirmed on a test event.

**Owner:** SRE lead.

## Gate 6 — Deploy & verify rehearsal

- [ ] Full deploy → `verify:deployment` → rollback → `verify:deployment`
      rehearsed in staging by the person who will run the production
      deploy ([ops.md](ops.md)).
- [ ] Smoke: register → OTP login → create listing → place escrow order →
      notification received, on staging with production-identical config.

**Owner:** release manager.

## Gate 7 — Translation & content vendor

- [ ] Farmer-facing translations (ha/yo/ig at minimum per PRD) delivered
      by the vendor and loaded; spot-checked by a native speaker on the
      team or community partner.
- [ ] Advisory/educational content loaded through the CMS path.
- [ ] USSD/IVR voice + SMS copy reviewed for the same locales.

**Owner:** content/operations lead.

## Gate 8 — Final go/no-go

- [ ] Gates 1–7 recorded complete with owners and dates.
- [ ] Support channel staffed for launch week; incident-response runbook
      acknowledged by on-call ([incident-response.md](incident-response.md)).
- [ ] Go/no-go meeting held; decision recorded.

**Owner:** product lead + engineering lead (joint sign-off).

## Stage 27 rollout addendum

- [ ] Rollout flags enabled one feature/environment at a time — every
      Stage-27 innovation ships default-OFF (`coop-pool-listings`,
      `dealer-qr-pay`, `float-forecaster`, `float-sentinel`,
      `geo-sealed-delivery`, `lender-lens`, `offtake-contracts`,
      `planting-window-pulse`, `price-wire`, `regen-discount`,
      `seasonal-repayment`, `voice-teller`, `voucher-insurance-rider`,
      `whr-ltv-guardian`, `evidence-locker`, `dds-studio`); enable only after
      the target environment's integrations are validated for that feature
      (evidence-pack §5; readiness-report §7).
- [ ] Fourth PAT revoked (posted in plaintext during the merge wave — treat
      as compromised; merge-log).
- [ ] Dependabot PRs #24/#26/#29/#30 triaged; stray stage27/* branches
      deleted (evidence-pack §4.6/§4.7).
- [ ] Smoke job confirmed green post-`23fcc5c3` before closing the sequence.
