-- 112_parametric_payout_disputes_settlement.sql — V-42 dispute/appeal +
-- V-43 settlement confirmation for parametric payouts.
--   * status ladder widened: disputed / rejected / appealed / settled;
--   * ex-gratia payouts (basis-risk safety valve) carry no trigger event, so
--     trigger_event_id goes nullable and the one-payout-per-trigger unique
--     index becomes partial;
--   * audit-trail columns for dispute/rejection/appeal/re-evaluation and
--     rail-confirmation settlement (settled only via rail reference, never
--     the ledger posting alone).
-- Idempotent: safe to re-apply.

BEGIN;

ALTER TABLE insurance.payouts DROP CONSTRAINT IF EXISTS payouts_status_check;
ALTER TABLE insurance.payouts
    ADD CONSTRAINT payouts_status_check
    CHECK (status IN ('proposed','disputed','rejected','appealed','paid','settled'));

ALTER TABLE insurance.payouts ALTER COLUMN trigger_event_id DROP NOT NULL;

DROP INDEX IF EXISTS insurance_payouts_trigger_event_uq;
CREATE UNIQUE INDEX IF NOT EXISTS insurance_payouts_trigger_event_uq
    ON insurance.payouts (trigger_event_id) WHERE trigger_event_id IS NOT NULL;

ALTER TABLE insurance.payouts
    ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'parametric';
ALTER TABLE insurance.payouts DROP CONSTRAINT IF EXISTS payouts_origin_check;
ALTER TABLE insurance.payouts
    ADD CONSTRAINT payouts_origin_check CHECK (origin IN ('parametric','ex_gratia'));

ALTER TABLE insurance.payouts ADD COLUMN IF NOT EXISTS disputed_at timestamptz;
ALTER TABLE insurance.payouts ADD COLUMN IF NOT EXISTS dispute_reason text;
ALTER TABLE insurance.payouts ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE insurance.payouts ADD COLUMN IF NOT EXISTS rejection_reason text;
ALTER TABLE insurance.payouts ADD COLUMN IF NOT EXISTS appealed_at timestamptz;
ALTER TABLE insurance.payouts ADD COLUMN IF NOT EXISTS appeal_reason text;
ALTER TABLE insurance.payouts ADD COLUMN IF NOT EXISTS reevaluated_at timestamptz;
ALTER TABLE insurance.payouts ADD COLUMN IF NOT EXISTS settled_at timestamptz;
ALTER TABLE insurance.payouts ADD COLUMN IF NOT EXISTS settlement_reference text;
ALTER TABLE insurance.payouts ADD COLUMN IF NOT EXISTS settlement_failure_reason text;
-- V-43 re-queue: settlement attempt counter (fresh idempotency key per attempt).
ALTER TABLE insurance.payouts
    ADD COLUMN IF NOT EXISTS settlement_attempts integer NOT NULL DEFAULT 0;

COMMIT;
