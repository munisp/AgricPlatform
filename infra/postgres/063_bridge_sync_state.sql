-- 063_bridge_sync_state.sql — WP-G20: scheduled bridge-sync bookkeeping.
--
-- The Moodle / Discourse / Directus bridge clients (integrations module,
-- wave P1) existed with zero consumers. The WP-G20 sync jobs pull the
-- remote catalogue/metadata into the EXISTING target tables
-- (learning.courses, community.forum_topics, advisory.items — all present
-- since 001_init.sql), so the only new storage needed is one narrow
-- sync-state table serving all three bridges:
--
--   bridge        — 'moodle' | 'discourse' | 'directus'
--   last_synced_at — when the last successful sync completed
--   last_status   — never | ok | failed | skipped (skipped = config-gated
--                   no-op, e.g. flag on but client unconfigured, or the
--                   circuit breaker open)
--   payload_hash  — sha256 of the fetched payload for change detection
--   detail        — short human/ops-readable reason for failed/skipped
--
-- Idempotent per repo policy (IF NOT EXISTS / ON CONFLICT). No triggers,
-- per repo convention. Additive only.

BEGIN;

CREATE TABLE IF NOT EXISTS integrations.bridge_sync_state (
    bridge         text PRIMARY KEY
                   CHECK (bridge IN ('moodle','discourse','directus')),
    last_synced_at timestamptz,
    last_status    text NOT NULL DEFAULT 'never'
                   CHECK (last_status IN ('never','ok','failed','skipped')),
    payload_hash   text,
    detail         text,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per bridge makes sync state discoverable before the first run.
INSERT INTO integrations.bridge_sync_state (bridge)
VALUES ('moodle'), ('discourse'), ('directus')
ON CONFLICT (bridge) DO NOTHING;

COMMIT;
