-- 009_analytics_marts.sql — Wave P5c: lakehouse-ready KPI data marts (M13)
-- and the recommendation feedback loop (M16 Phase 3).
--
-- All statements are idempotent (IF NOT EXISTS). Mart tables are keyed by
-- snapshot_date (Africa/Lagos calendar day) — the natural partition key for
-- the warehouse handoff. Column layouts below are the parquet-ready schema
-- contract mirrored 1:1 by the CSV export endpoint
-- (GET /api/v1/analytics/marts/:mart/export):
--
--   analytics_marts.member_kpis_daily
--     snapshot_date date PK, total_members int, new_members int,
--     active_members int, verified_members int, complete_profiles int,
--     avg_profile_completion double
--   analytics_marts.marketplace_daily
--     snapshot_date date PK, active_listings int, total_orders int,
--     new_orders int, gmv_naira double
--   analytics_marts.learning_daily
--     snapshot_date date PK, total_courses int, total_enrolments int,
--     new_enrolments int, completions int, completion_rate double

BEGIN;

CREATE SCHEMA IF NOT EXISTS analytics_marts;

CREATE TABLE IF NOT EXISTS analytics_marts.member_kpis_daily (
    snapshot_date          date PRIMARY KEY,        -- Africa/Lagos calendar day
    total_members          integer NOT NULL,        -- cumulative registered members
    new_members            integer NOT NULL,        -- registered on snapshot_date
    active_members         integer NOT NULL,        -- last_active_at on snapshot_date
    verified_members       integer NOT NULL,        -- cumulative verified members
    complete_profiles      integer NOT NULL,        -- profiles scoring >= 60 ('complete')
    avg_profile_completion double precision NOT NULL, -- mean completion score (2dp)
    snapshotted_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics_marts.marketplace_daily (
    snapshot_date   date PRIMARY KEY,
    active_listings integer NOT NULL,
    total_orders    integer NOT NULL,
    new_orders      integer NOT NULL,               -- created on snapshot_date
    gmv_naira       double precision NOT NULL,      -- sum of order totals on snapshot_date
    snapshotted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics_marts.learning_daily (
    snapshot_date    date PRIMARY KEY,
    total_courses    integer NOT NULL,
    total_enrolments integer NOT NULL,
    new_enrolments   integer NOT NULL,              -- started on snapshot_date
    completions      integer NOT NULL,              -- completed on snapshot_date
    completion_rate  double precision NOT NULL,     -- cumulative completions / enrolments
    snapshotted_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- recommendation feedback events (clicked/dismissed) feeding the ranking
-- adjustment; append-only, one row per member action.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search.recommendation_feedback (
    id          text PRIMARY KEY,
    user_id     text NOT NULL REFERENCES identity.users(id),
    item_type   text NOT NULL
                CHECK (item_type IN ('course','opportunity','listing','knowledge')),
    item_id     text NOT NULL,
    action      text NOT NULL CHECK (action IN ('clicked','dismissed')),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS search_recommendation_feedback_user_idx
    ON search.recommendation_feedback (user_id);
CREATE INDEX IF NOT EXISTS search_recommendation_feedback_item_idx
    ON search.recommendation_feedback (item_type, item_id);

COMMIT;
