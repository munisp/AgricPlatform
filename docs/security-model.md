# Security model — verified platform facts

Short, evidence-backed statements recorded during the 2026-10-03 mapping
pass. Each fact was verified against the referenced source; these are
**closed — not defects** (GAP-I03, GAP-I04). If a referenced file changes,
re-verify the statement.

## Destructive deletes and fire-and-forget writes (GAP-I03)

Destructive deletes and retention purges in this codebase are deliberate,
guarded, and dry-run capable; every fire-and-forget write has a durable
backstop. No un-backed fire-and-forget write was found.

- `infra/postgres/119_drop_orphan_tables.sql` — the DROP of 18 tables was a
  deliberate removal of verified-orphan tables, not an accident surface.
- `apps/api/src/modules/compliance/compliance-retention.service.ts:187-241`
  — retention purges are policy-gated and support dry-run and anonymize
  options before any destructive execution.
- `apps/api/src/modules/agent-banking/agent-banking.service.ts:1182` —
  voucher-claim rollbacks are gated on a bounded ledger-truth probe.
- Outbound/event writes ride the transactional outbox
  (`events.outbox` + `events.processed_events` dedupe ledger) so a crash
  mid-write is replayable rather than lost.

## CSRF posture (GAP-I04)

The API carries **no CSRF middleware by design**: it is a bearer-token API
with no cookie-authentication surface, so there is no ambient browser
credential for a cross-site request to ride on.

- `apps/api/src/bootstrap.ts:59-65` — helmet + credentialled CORS; cookies
  are not used for authentication.
- `apps/api/src/common/auth/roles.guard.ts:38-43` — authentication reads
  the `Authorization` header; no cookie auth is observed anywhere in the
  guard chain.

Revisit this section if a cookie-based session mechanism is ever
introduced (e.g. for a first-party web session cookie) — at that point
CSRF protection (SameSite + token, or origin checking) becomes mandatory.
