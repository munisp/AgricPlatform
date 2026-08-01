# Runbook: Incident Response

Applies to staging and production AgricPlatform services. Phase 1 scope: no
24/7 on-call tooling is provisioned yet (EXTERNAL); this runbook defines the
manual process until monitoring/alerting exists.

## 1. Severity levels

| Level | Definition | Examples | Response target |
| --- | --- | --- | --- |
| SEV1 | Platform down or data at risk | API unreachable, database corruption, confirmed data breach, payment misposting | Immediate; all-hands |
| SEV2 | Major journey degraded | OTP not delivering, login broken for a role, privacy export failing | Same business day |
| SEV3 | Partial degradation | Single provider failing with stub fallback, slow queries | Next business day |
| SEV4 | Cosmetic / no user impact | UI glitch, non-blocking log noise | Backlog triage |

## 2. First-response checklist

1. **Acknowledge and log.** Open an incident record (issue labelled
   `type: bug`, `priority: P0/P1`, `status: blocked`) with a UTC timeline.
2. **Assess blast radius.** Which journeys (J1 onboarding …) and which
   environment? Check `/api/v1/health` and `/api/v1/health/ready` — the ready
   endpoint reports each integration adapter's status.
3. **Stabilise before fixing.** Prefer rollback (redeploy previous image tag —
   see `docs/runbooks/deployment.md`) or driver downgrade (`*_DRIVER=stub`)
   over hot-patching production.
4. **Preserve evidence.** Snapshot logs, failing request IDs, and (for data
   incidents) a database snapshot before remediation.

## 3. Data breach / privacy incidents (NDPR scope)

1. Contain: revoke the affected credential, disable the affected integration,
   or isolate the affected data set.
2. Do **not** delete audit trails: `admin.audit_events` and `events.outbox`
   are the forensic record.
3. Escalate to the Data Protection Officer (appointment is launch blocker L2
   in `docs/security-compliance.md` — until appointed, escalate to the
   maintainers team lead).
4. NDPR/NDPA regulator and affected-user notification decisions are made by
   the DPO/legal, never unilaterally by engineering.
5. Honour in-flight privacy requests: a user deletion/export request must not
   be lost because of the incident.

## 4. Payment incidents

1. Stop new charges: set `PAYMENT_DRIVER=stub` via the environment config
   overlay and redeploy, or scale down the API if posting is unsafe.
2. Reconcile from the provider dashboard against the finance ledger; every
   correction goes through the idempotent, audit-logged finance endpoints —
   never direct SQL in production.
3. Webhook replay: re-deliver signed webhooks from the provider console after
   the API is healthy; the idempotency layer deduplicates.

## 5. Provider outage (SMS/WhatsApp/email/push)

1. Confirm via `/api/v1/health/ready` which adapter is degraded.
2. Switch the affected driver to `stub` or the alternate provider if
   configured; communicate OTP delays to users via an unaffected channel.
3. Track delivery backlog; flush queued notifications after recovery.

## 6. Rollback and restore references

- Application rollback: `docs/runbooks/deployment.md` § Rollback.
- Data restore: `docs/runbooks/backup-restore.md` § 4.
- DR failover order: `infra/environments.md` § dr.

## 7. Post-incident

1. Close the record with: timeline, root cause, detection gap, and
   follow-up issues.
2. SEV1/SEV2 require a written postmortem within 5 business days.
3. Feed every detection gap into monitoring requirements for the launch gate
   (60 days of monitored uptime evidence — blocker #7 in
   `docs/production-readiness.md`).
