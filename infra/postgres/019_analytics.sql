-- 019_analytics.sql — Wave B: honest analytics foundation (star-schema marts
-- inside PostgreSQL).
--
-- There is NO lakehouse today: no Spark, no Iceberg, no Trino, no object
-- storage. These tables are the REAL analytical store — a star schema in the
-- `analytics` schema of the same Postgres cluster — populated by the
-- outbox→mart projector (modules/analytics/projector.service.ts) from
-- events.outbox domain events. They are also the handoff contract: the CSV
-- exports (GET /api/v1/analytics/export/*.csv) mirror these columns 1:1 so a
-- future lakehouse (object storage + Iceberg + Trino/Spark) can ingest them
-- unchanged. See docs/analytics-lakehouse.md.
--
-- Grain & keys (all upserts are by natural key → replaying the outbox
-- history yields identical marts):
--
--   analytics.dim_users          user_id PK      — roles, state, chapter
--   analytics.dim_listings       listing_id PK   — kind, crop, state
--   analytics.fact_orders        order_id PK     — buyer/seller dims, channel,
--                                                  variant, kobo amounts,
--                                                  status_history_count,
--                                                  placed_at, fulfilled_at
--   analytics.fact_payments      entry_id PK     — ledger journal entries:
--                                                  accounts, amount_kobo,
--                                                  transfer type, posted_at
--   analytics.fact_livestock     animal_id PK    — registrations, species/state
--   analytics.mart_daily_metrics metric_date PK  — rollups (GMV, orders,
--                                                  active farmers, escrow held,
--                                                  livestock registered)
--   analytics.projection_state   consumer PK     — projector cursor/heartbeat
--                                                  for the /health/modules probe
--
-- Money is integer kobo (bigint) throughout. Dates for mart_daily_metrics
-- are Africa/Lagos calendar days. Idempotent (IF NOT EXISTS) per migration
-- policy.

BEGIN;

CREATE SCHEMA IF NOT EXISTS analytics;

-- ---------------------------------------------------------------------------
-- Dimensions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics.dim_users (
    user_id         text PRIMARY KEY,
    roles           text[] NOT NULL DEFAULT '{}',
    state           text,                       -- profile location.state
    chapter_id      text,                       -- chapter the user leads (see docs;
                                                -- per-member affiliation is not
                                                -- modelled in the OLTP schema yet)
    registered_at   timestamptz NOT NULL,
    projected_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics.dim_listings (
    listing_id      text PRIMARY KEY,
    seller_id       text NOT NULL,
    kind            text NOT NULL,              -- produce|input|service|equipment|storage|transport
    crop            text,
    state           text,                       -- listing location.state
    created_at      timestamptz NOT NULL,
    projected_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dim_listings_kind_state_idx
    ON analytics.dim_listings (kind, state);

-- ---------------------------------------------------------------------------
-- Facts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics.fact_orders (
    order_id            text PRIMARY KEY,
    listing_id          text NOT NULL,
    buyer_id            text NOT NULL,
    seller_id           text NOT NULL,
    channel             text NOT NULL DEFAULT 'web',  -- order_extensions side table
    variant_id          text,
    quantity            numeric(14,2) NOT NULL,
    total_kobo          bigint NOT NULL CHECK (total_kobo >= 0),
    status              text NOT NULL,          -- mirrors marketplace.orders vocabulary
    status_history_count integer NOT NULL DEFAULT 0, -- status_changed events applied
    escrow_required     boolean NOT NULL DEFAULT false,
    placed_at           timestamptz NOT NULL,
    fulfilled_at        timestamptz,            -- set when status first reaches 'completed'
    projected_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fact_orders_placed_at_idx
    ON analytics.fact_orders (placed_at);
CREATE INDEX IF NOT EXISTS fact_orders_buyer_idx
    ON analytics.fact_orders (buyer_id, placed_at);
CREATE INDEX IF NOT EXISTS fact_orders_seller_idx
    ON analytics.fact_orders (seller_id, placed_at);
CREATE INDEX IF NOT EXISTS fact_orders_channel_idx
    ON analytics.fact_orders (channel, placed_at);

-- One row per double-entry journal entry (finance.ledger.entry_posted).
-- debit_accounts/credit_accounts preserve the posting account codes; the
-- entry is balanced so amount_kobo is the debit (== credit) total.
CREATE TABLE IF NOT EXISTS analytics.fact_payments (
    entry_id        text PRIMARY KEY,
    idempotency_key text NOT NULL,
    reference_type  text,                       -- transfer type, e.g. marketplace_order|payout|fee
    reference_id    text,
    debit_accounts  text[] NOT NULL DEFAULT '{}',
    credit_accounts text[] NOT NULL DEFAULT '{}',
    amount_kobo     bigint NOT NULL CHECK (amount_kobo >= 0),
    posted_at       timestamptz NOT NULL,
    projected_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fact_payments_posted_at_idx
    ON analytics.fact_payments (posted_at);
CREATE INDEX IF NOT EXISTS fact_payments_reference_idx
    ON analytics.fact_payments (reference_type, posted_at);

CREATE TABLE IF NOT EXISTS analytics.fact_livestock (
    animal_id       text PRIMARY KEY,           -- NG-{SPECIES}-{STATE}-{serial}
    owner_user_id   text NOT NULL,
    species         text NOT NULL,              -- cattle|sheep|goat|chicken|pig
    breed           text NOT NULL,
    state           text NOT NULL,
    status          text NOT NULL,              -- alive|sold|dead|stolen
    registered_at   timestamptz NOT NULL,
    projected_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fact_livestock_registered_at_idx
    ON analytics.fact_livestock (registered_at);
CREATE INDEX IF NOT EXISTS fact_livestock_species_state_idx
    ON analytics.fact_livestock (species, state);

-- ---------------------------------------------------------------------------
-- Daily rollup mart (Africa/Lagos calendar days). Recomputed from the fact
-- tables + escrow records by the projector for every date it touched, so a
-- full replay reproduces identical rows.
--
-- Metric definitions (docs/analytics-lakehouse.md):
--   orders_gmv_kobo    sum(total_kobo) of orders PLACED on metric_date
--   orders_count       count of orders placed on metric_date
--   active_farmers     distinct sellers with >= 1 order placed on metric_date
--   escrow_held_kobo   escrow exposure at end of metric_date (held_at <= EOD
--                      and unresolved at EOD), reconstructed from escrow rows
--   livestock_registered  animals registered on metric_date
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics.mart_daily_metrics (
    metric_date         date PRIMARY KEY,       -- Africa/Lagos calendar day
    orders_gmv_kobo     bigint NOT NULL DEFAULT 0,
    orders_count        integer NOT NULL DEFAULT 0,
    active_farmers      integer NOT NULL DEFAULT 0,
    escrow_held_kobo    bigint NOT NULL DEFAULT 0,
    livestock_registered integer NOT NULL DEFAULT 0,
    recomputed_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Projector cursor/heartbeat: one row per consumer. processed_events remains
-- the idempotency ledger; this table exists so operators (and the
-- /health/modules analytics probe) can see liveness without scanning it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics.projection_state (
    consumer            text PRIMARY KEY,
    last_run_at         timestamptz NOT NULL,
    last_event_id       text,
    last_event_at       timestamptz,
    processed_total     bigint NOT NULL DEFAULT 0
);

COMMIT;
