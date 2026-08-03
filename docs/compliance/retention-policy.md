# Retention Policy — defaults and operations

> **Template prepared for qualified Nigerian legal review — not legal advice, not reviewed, not signed off.**
> The values below are engineering defaults shipped with migration 021 so the retention
> machinery works end-to-end. A qualified DPO must replace them with the organisation's
> approved retention schedule before production reliance.

## How retention is enforced (code)

- Policies live in `compliance.retention_policies` (migration `021_compliance.sql`) and are
  readable/upsertable by admins via `GET|POST /compliance/retention/policies`.
- `ComplianceRetentionService.sweep()` (`apps/api/src/modules/compliance/compliance-retention.service.ts`)
  walks every policy row, finds entities past `retain_days`, and either **anonymises**
  (`anonymize_not_delete = true`: the user reference is replaced with the deterministic
  tombstone `redacted:<sha256>` — the row survives as proof/evidence) or **purges**
  (`false`: rows are hard-deleted). Unknown entity keys are reported as `skipped`, never
  silently ignored.
- The sweeper is **endpoint-driven** (same philosophy as `scripts/sweep-outbox.mjs`): the API
  starts no timers. An external scheduler invokes it:

  ```cron
  # Nightly dry-run report (safe):
  15 2 * * * curl -fsS -X POST "$API/compliance/retention/sweep" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{}'
  # Weekly execute (explicit opt-in):
  30 3 * * 0 curl -fsS -X POST "$API/compliance/retention/sweep" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"dryRun": false}'
  ```

  The endpoint **defaults to `dryRun: true`** — execution requires an explicit
  `{ "dryRun": false }` body. Every pass (dry-run or execute) is recorded in the audit chain.

## Default policies (TEMPLATE values)

| Entity key | What is matched | retain_days | Action | Rationale (to confirm) |
|---|---|---|---|---|
| `compliance.consent_records` | Consents whose `revoked_at` is past the window | 730 | Anonymise (tombstone `user_id`) | Consent history is the controller's proof of lawful basis; keep the fact, drop the person |
| `compliance.data_subject_requests` | Closed (`completed`/`rejected`) DSRs past the window | 1095 | Anonymise (`user_id`) | Evidence of rights handling; 3-year placeholder |
| `notifications.messages` | Notifications with `created_at` past the window | 365 | Purge (hard delete) | Transient messaging; no evidence value |

**Never in scope (legal hold):** orders, ledger/finance rows, escrow, invoices, audit events.
These survive erasure and retention sweeps — see `legal-review-checklist.md` (CBN/PSB
record-keeping caution) for the human review this assumption requires.

## Changing a policy

1. `POST /compliance/retention/policies` (admin) with
   `{ "entity": "<key>", "retainDays": <int>, "anonymizeNotDelete": <bool> }` — audited.
2. Run a dry-run sweep and review `matched` counts before executing.
3. Record the DPO's approval of the new value in the change ticket (human step).

Adding retention for a new entity requires a handler case in
`ComplianceRetentionService.sweepEntity()` plus pg + in-memory repository operations —
until then the entity is reported `skipped` (fail-visible, not fail-silent).
