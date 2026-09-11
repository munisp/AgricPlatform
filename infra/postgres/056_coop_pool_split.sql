-- 056_coop_pool_split.sql — Stage 27 Batch 1, Innovation 2: Coop Pool & Split.
--
-- A cooperative pools member harvest into one graded bulk listing; when the
-- buyer's escrow is RELEASED, the ledger auto-splits the proceeds to each
-- member's ledger sub-account by pre-agreed shares (share_bps, computed at
-- lock time with largest-remainder rounding so the shares sum to exactly
-- 10000).
--
-- Exactly-once settlement doctrine (mirrors the Stage 23/24 payout rail):
-- the split is claimed by inserting ONE marker row per pool into
-- marketplace.pool_split_markers with a targetless ON CONFLICT DO NOTHING
-- inside the SAME transaction as the ledger transfer + member credit
-- postings + the pool status CAS. A committed marker therefore proves the
-- split journal committed; a replay sees the marker and no-ops. The in-
-- transaction check against finance.transfer_is_balanced() plus the credit
-- sum vs. the escrow release amount make an unbalanced or partial split
-- roll the whole transaction back.
--
-- Cross-domain references (cooperative_id → chapters/users, member_user_id
-- → users, ledger_account_code / ledger_entry_id → finance.*) stay plain
-- columns per the repo's no-cross-schema-FK convention; intra-schema FKs
-- reference marketplace tables from 001_init.sql / 003_commerce_finance.sql.
--
-- Idempotent per migration policy (IF NOT EXISTS throughout). No triggers,
-- per repo convention. Money is integer kobo (CHECK > 0).

BEGIN;

-- ---------------------------------------------------------------------------
-- marketplace: cooperative pool listings (draft|open → locked → settled)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.pool_listings (
    id               text PRIMARY KEY,
    cooperative_id   text NOT NULL,          -- cooperative (chapter) id; cross-domain: plain text
    listing_id       text UNIQUE REFERENCES marketplace.listings(id),  -- set at lock
    title            text NOT NULL,
    crop             text,
    unit_price_kobo  bigint NOT NULL CHECK (unit_price_kobo > 0),
    location_state   text,
    location_lga     text,
    location_ward    text,
    min_pool_qty_kg  integer NOT NULL CHECK (min_pool_qty_kg > 0),
    total_qty_kg     integer NOT NULL DEFAULT 0 CHECK (total_qty_kg >= 0),
    status           text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('draft','open','locked','settled')),
    locked_at        timestamptz,
    settled_at       timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pool_listings_cooperative_idx
    ON marketplace.pool_listings (cooperative_id);
CREATE INDEX IF NOT EXISTS pool_listings_status_idx
    ON marketplace.pool_listings (status);

-- ---------------------------------------------------------------------------
-- marketplace: member contributions (pledged → delivered|rejected → paid)
-- share_bps is NULL until lock computes it; CHECK enforces the per-member
-- bound while the service enforces the Σ = 10000 pool invariant at lock.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.pool_contributions (
    id                  text PRIMARY KEY,
    pool_id             text NOT NULL REFERENCES marketplace.pool_listings(id),
    member_user_id      text NOT NULL,       -- cross-domain: plain text
    qty_kg              integer NOT NULL CHECK (qty_kg > 0),
    quality_grade       text NOT NULL,
    share_bps           integer CHECK (share_bps BETWEEN 1 AND 10000),
    ledger_account_code text NOT NULL,       -- member:<userId>:coop_pool
    amount_kobo         bigint CHECK (amount_kobo > 0),  -- set at settlement
    status              text NOT NULL DEFAULT 'pledged'
                        CHECK (status IN ('pledged','delivered','rejected','paid')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
-- A member pledges to a pool exactly once (idempotent pledge retries replay
-- the stored contribution; the service maps 23505 → 409 for conflicts).
CREATE UNIQUE INDEX IF NOT EXISTS pool_contributions_pool_member_uq
    ON marketplace.pool_contributions (pool_id, member_user_id);
CREATE INDEX IF NOT EXISTS pool_contributions_member_idx
    ON marketplace.pool_contributions (member_user_id);

-- ---------------------------------------------------------------------------
-- marketplace: split markers — the exactly-once arbiter for pool settlement.
-- One row per pool (PRIMARY KEY on pool_id); inserted with targetless
-- ON CONFLICT DO NOTHING in the same transaction as the member credit
-- postings. ledger_entry_id is a plain uuid column (no cross-schema FK to
-- finance.ledger_transfers, per repo convention).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.pool_split_markers (
    pool_id          text PRIMARY KEY REFERENCES marketplace.pool_listings(id),
    escrow_id        text NOT NULL REFERENCES marketplace.escrow_records(id),
    ledger_entry_id  uuid NOT NULL,
    total_kobo       bigint NOT NULL CHECK (total_kobo > 0),
    member_count     integer NOT NULL CHECK (member_count > 0),
    idempotency_key  text NOT NULL,          -- coop-pool-split:<poolId>
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pool_split_markers_idempotency_key_uq
    ON marketplace.pool_split_markers (idempotency_key);

COMMIT;
