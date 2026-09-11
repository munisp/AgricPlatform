-- 050_vsla_close_cycle_plan.sql — persisted VSLA close-cycle distribution
-- plan (stage-24 audit A4-4). closeCycle used to recompute pro-rata member
-- shares from the LIVE pooled-cash balance on every retry, so a crash after
-- the first member's payout recommitted a share-out computed from the
-- REDUCED pool: remaining members were underpaid, funds stayed stranded in
-- the pool and the close report understated the distributable total.
--
-- The fix persists the computed payout vector (one row per member) BEFORE
-- the first payout posts to the ledger; crash-resume and concurrent closers
-- pay the remaining members from these rows and never recompute shares from
-- mutated pool state. Money movement itself stays in the finance ledger —
-- this table is an operational plan cross-referenced by the payout rows in
-- vsla_carbon.vsla_share_outs.
--
-- Idempotent per migration policy: IF NOT EXISTS everywhere; PostgreSQL has
-- no ADD CONSTRAINT IF NOT EXISTS, so constraints use the sanctioned
-- pg_constraint DO-block pattern (019a_listing_certified_link.sql).

BEGIN;

CREATE TABLE IF NOT EXISTS vsla_carbon.vsla_share_out_plan (
    id                  text PRIMARY KEY,
    cycle_id            text NOT NULL,
    member_id           text NOT NULL,
    share_kobo          bigint NOT NULL,  -- pro-rata share from the pre-payout pool snapshot
    contributed_kobo    bigint NOT NULL,  -- member's cycle contribution total at close
    residual_kobo       bigint NOT NULL,  -- liability deferred while loans are outstanding
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- Foreign keys (019a-style pg_constraint guards).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'vsla_share_out_plan_cycle_fkey'
    ) THEN
        ALTER TABLE vsla_carbon.vsla_share_out_plan
            ADD CONSTRAINT vsla_share_out_plan_cycle_fkey
            FOREIGN KEY (cycle_id) REFERENCES vsla_carbon.vsla_cycles (id);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'vsla_share_out_plan_member_fkey'
    ) THEN
        ALTER TABLE vsla_carbon.vsla_share_out_plan
            ADD CONSTRAINT vsla_share_out_plan_member_fkey
            FOREIGN KEY (member_id) REFERENCES vsla_carbon.vsla_members (id);
    END IF;
END $$;

-- One plan row per (cycle, member): concurrent closers converge on the same
-- stored vector (second INSERT 23505s and adopts the winner's row).
CREATE UNIQUE INDEX IF NOT EXISTS vsla_share_out_plan_cycle_member_idx
    ON vsla_carbon.vsla_share_out_plan (cycle_id, member_id);

-- Kobo CHECKs: plan amounts are non-negative (a zero-share member still gets
-- a plan row so the resume path has a complete vector).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'vsla_share_out_plan_share_kobo_check'
    ) THEN
        ALTER TABLE vsla_carbon.vsla_share_out_plan
            ADD CONSTRAINT vsla_share_out_plan_share_kobo_check
            CHECK (share_kobo >= 0);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'vsla_share_out_plan_contributed_kobo_check'
    ) THEN
        ALTER TABLE vsla_carbon.vsla_share_out_plan
            ADD CONSTRAINT vsla_share_out_plan_contributed_kobo_check
            CHECK (contributed_kobo >= 0);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'vsla_share_out_plan_residual_kobo_check'
    ) THEN
        ALTER TABLE vsla_carbon.vsla_share_out_plan
            ADD CONSTRAINT vsla_share_out_plan_residual_kobo_check
            CHECK (residual_kobo >= 0);
    END IF;
END $$;

COMMIT;
