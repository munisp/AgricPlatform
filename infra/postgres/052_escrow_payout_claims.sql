-- 052_escrow_payout_claims.sql — Stage 24 audit fix A4-3: payout rail
-- attempt claim state.
--
-- Migration 048 recorded payout attempts with statuses
-- recorded|succeeded|failed and no claim state: two concurrent retries of a
-- failed attempt both passed the idempotency replay check and BOTH invoked
-- the payout driver with the same key (double disbursement the moment a
-- non-idempotent PSSP client lands), and the unguarded status write could
-- regress succeeded→failed, causing yet another driver call.
--
-- This migration adds the claim lease column and admits the 'in_progress'
-- claim status. The service layer claims an attempt with a guarded CAS
-- (recorded|failed|expired-claim → in_progress, exactly one winner; a
-- concurrent retry seeing a fresh in_progress claim is rejected 409) and
-- finalizes with a guarded write that can never overwrite 'succeeded'.
--
-- Idempotent per repo policy (IF NOT EXISTS / pg_constraint DO block).
-- No triggers, per repo convention.

BEGIN;

ALTER TABLE marketplace.escrow_payouts
    ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'escrow_payouts_status_check'
    ) THEN
        ALTER TABLE marketplace.escrow_payouts
            DROP CONSTRAINT escrow_payouts_status_check;
    END IF;
    ALTER TABLE marketplace.escrow_payouts
        ADD CONSTRAINT escrow_payouts_status_check
        CHECK (status IN ('recorded','in_progress','succeeded','failed'));
END $$;

COMMIT;
