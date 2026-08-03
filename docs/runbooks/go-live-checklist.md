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
