-- 119_drop_orphan_tables.sql — OR-01: drop 18 orphan tables created by
-- 001_init.sql that have zero code references (verified by word-boundary
-- scan of apps/api/src, apps/web, apps/mobile, packages/shared, scripts,
-- services and infra; re-verified before authoring this file). None is
-- read or written by any service, repository, trigger or view.
--   * profiles.profile_completion_events
--   * community.group_members, community.mentorship_pairs,
--     community.moderation_reports
--   * opportunities.programme_cohorts (code uses programmes.cohorts)
--   * advisory.crop_calendar_entries, advisory.pest_alerts,
--     advisory.weather_snapshots, advisory.price_snapshots
--   * marketplace.buyer_requests
--   * finance.kyc_records, finance.lender_matches
--   * notifications.notification_templates
--   * admin.review_queue_items, admin.platform_kpi_snapshots
--   * analytics.export_jobs
--   * integrations.webhook_endpoints, integrations.webhook_deliveries
-- marketplace.order_events is deliberately NOT dropped: the migration
-- runner's compose-bootstrap probe (apps/api/src/database/migrate.ts)
-- detects an out-of-band-applied baseline via to_regclass(
-- 'marketplace.order_events_order_id_idx'); dropping the table would
-- remove that probe artifact.
-- FK note: integrations.webhook_deliveries references
-- integrations.webhook_endpoints, so deliveries is dropped first; no
-- surviving table references any of these, so no CASCADE is needed.
-- Idempotent per migration policy: DROP TABLE IF EXISTS, safe to re-run.

BEGIN;

DROP TABLE IF EXISTS integrations.webhook_deliveries;
DROP TABLE IF EXISTS integrations.webhook_endpoints;
DROP TABLE IF EXISTS profiles.profile_completion_events;
DROP TABLE IF EXISTS community.group_members;
DROP TABLE IF EXISTS community.mentorship_pairs;
DROP TABLE IF EXISTS community.moderation_reports;
DROP TABLE IF EXISTS opportunities.programme_cohorts;
DROP TABLE IF EXISTS advisory.crop_calendar_entries;
DROP TABLE IF EXISTS advisory.pest_alerts;
DROP TABLE IF EXISTS advisory.weather_snapshots;
DROP TABLE IF EXISTS advisory.price_snapshots;
DROP TABLE IF EXISTS marketplace.buyer_requests;
DROP TABLE IF EXISTS finance.kyc_records;
DROP TABLE IF EXISTS finance.lender_matches;
DROP TABLE IF EXISTS notifications.notification_templates;
DROP TABLE IF EXISTS admin.review_queue_items;
DROP TABLE IF EXISTS admin.platform_kpi_snapshots;
DROP TABLE IF EXISTS analytics.export_jobs;

COMMIT;
