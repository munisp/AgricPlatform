-- 121_drop_orphan_tables.sql — GAP-H10: drop the 3 confirmed orphan tables
-- missed by 119_drop_orphan_tables.sql. Evidence: mapping-gap-register.md
-- GAP-H10 (dim09 tablesWithoutRepositoryOwner, dim04 orphanTables) and
-- mapping-verification.md conflict C-03 — word-boundary scans of apps/api,
-- apps/web, apps/mobile, packages, services and scripts find zero code
-- references to any of these tables; none is read or written by any
-- service, repository, trigger or view.
--   * privacy.processing_register (001_init.sql:133) — zero references
--     outside infra/postgres.
--   * community.groups (001_init.sql:240) — its FK children
--     (community.group_members / mentorship_pairs / moderation_reports)
--     were dropped by 119:33-35; the parent was missed. No surviving table
--     references it.
--   * integrations.providers (001_init.sql:772) — seeded reference data
--     (001_init.sql:835) with no repository reads; provider readiness is
--     config/driver-based. Its only FK dependents
--     (integrations.webhook_endpoints / webhook_deliveries) were dropped by
--     119:30-31, so no CASCADE is needed.
--
-- Deliberately NOT dropped (C-03 reconciliation of the dim04/dim09 count):
--   * analytics.events (001_init.sql:746) — WATCH ITEM: an orphan only
--     under a code-owner definition (its sole references are its own CREATE
--     and self-index, 001_init.sql:754); dim09's ownership rule counts that
--     self-index as ownership. Retained as a watch item per the C-03
--     recommendation; not dropped here.
--   * identity.roles — seeded reference data (001_init.sql:64) and FK
--     target of identity.user_roles (001_init.sql:45 REFERENCES
--     identity.roles(code)), which is actively read/written by
--     user.pg-repository.ts. Reference data, not an orphan; not dropped.
--   * marketplace.order_events — intentionally retained: the migration
--     runner's compose-bootstrap probe (apps/api/src/database/migrate.ts:78)
--     detects an out-of-band-applied baseline via to_regclass(
--     'marketplace.order_events_order_id_idx'); dropping the table would
--     remove that probe artifact (rationale recorded in
--     119_drop_orphan_tables.sql:18-22). Not dropped.
--
-- Destructive DDL, no down migration (recorded policy, docs/runbooks/ops.md)
-- — apply deliberately. Idempotent per migration policy:
-- DROP TABLE IF EXISTS, safe to re-run.

BEGIN;

DROP TABLE IF EXISTS privacy.processing_register;
DROP TABLE IF EXISTS community.groups;
DROP TABLE IF EXISTS integrations.providers;

COMMIT;
