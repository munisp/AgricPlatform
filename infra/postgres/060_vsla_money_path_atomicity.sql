-- 054_vsla_money_path_atomicity.sql — WP-G1 (stage 27, V2 funds-atomicity audit).
--
-- Three HIGH money-path fixes for the VSLA module:
--
-- 1. issueLoan idempotency: vsla_loans gains a client idempotency key with a
--    partial UNIQUE index. Before this, a transport retry of
--    POST /vsla-carbon/groups/:id/loans generated a fresh loanId per call and
--    posted a SECOND balanced disbursement — double-paying the pool. New rows
--    always carry a key; pre-054 legacy rows keep NULL (allowed multiple
--    times under the partial index).
--
-- 2. Share-out plan completion marker: pre-054 close-cycle plan rows were
--    inserted one-by-one in autocommit, and resume treated ANY non-empty plan
--    as complete — a crash mid-insert permanently excluded unplanned members
--    from the payout. The plan writer now inserts ALL rows plus one
--    vsla_share_out_plan_meta marker row in a single transaction (gated by an
--    ON CONFLICT DO NOTHING marker insert), and resume trusts a plan only
--    when its marker exists; rows without a marker are rebuilt, never paid.
--
-- (The phantom-repayment-claim fix — claimRepayment + ledger posting +
-- repayment row now commit in ONE transaction — is application-level and
-- needs no schema change.)
--
-- Idempotent (IF NOT EXISTS / ON CONFLICT-safe), no triggers, additive only.

BEGIN;

CREATE SCHEMA IF NOT EXISTS vsla_carbon;

-- (1) Client idempotency key on internal loans. Nullable so legacy rows need
-- no backfill; the partial unique index enforces exactly-once for keyed rows.
ALTER TABLE vsla_carbon.vsla_loans
    ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS vsla_carbon_loans_idempotency_key_uq
    ON vsla_carbon.vsla_loans (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- (2) Share-out plan completion marker. One row per cycle, written in the
-- SAME transaction as the full plan-row set: marker present ⟺ plan complete.
CREATE TABLE IF NOT EXISTS vsla_carbon.vsla_share_out_plan_meta (
    cycle_id            text PRIMARY KEY REFERENCES vsla_carbon.vsla_cycles(id),
    row_count           integer NOT NULL,
    total_share_kobo    bigint NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);

COMMIT;
