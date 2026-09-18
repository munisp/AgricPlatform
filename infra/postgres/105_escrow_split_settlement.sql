-- 105_escrow_split_settlement.sql — V-06: partial dispute awards / split
-- settlement for marketplace escrows (Wave-2 pack W2-C3).
--
-- Before this migration a disputed escrow resolved only all-or-nothing
-- (released | refunded for the full held amount). Grain-trade disputes are
-- usually PARTIAL (some bags short, a quality downgrade, partial delivery),
-- so the resolution now supports a split award: a partial release to the
-- seller plus a partial refund to the buyer, two balanced ledger legs
-- (marketplace_escrow_split_release / marketplace_escrow_split_refund)
-- summing EXACTLY to the held amount.
--
--   marketplace.escrow_records  gains released_kobo / refunded_kobo (the two
--                               award parts, set only on split settlement;
--                               CHECK: when present they sum to amount_kobo)
--                               and admits the terminal 'settled' status.
--
-- Idempotent per repo policy (IF NOT EXISTS / DROP+ADD constraint). No
-- triggers, per repo convention. Money is integer kobo.

BEGIN;

ALTER TABLE marketplace.escrow_records
    ADD COLUMN IF NOT EXISTS released_kobo bigint,
    ADD COLUMN IF NOT EXISTS refunded_kobo bigint;

ALTER TABLE marketplace.escrow_records
    DROP CONSTRAINT IF EXISTS escrow_records_status_check;
ALTER TABLE marketplace.escrow_records
    ADD CONSTRAINT escrow_records_status_check
    CHECK (status IN ('held','releasing','released','refunding','refunded','disputed','delivered_pending_confirm','settled'));

-- Split-amount invariant: both parts non-negative, and when the escrow is
-- settled both parts exist and sum exactly to the held amount.
ALTER TABLE marketplace.escrow_records
    DROP CONSTRAINT IF EXISTS escrow_records_split_amounts_check;
ALTER TABLE marketplace.escrow_records
    ADD CONSTRAINT escrow_records_split_amounts_check
    CHECK (
        (released_kobo IS NULL AND refunded_kobo IS NULL AND status <> 'settled')
        OR (released_kobo IS NOT NULL AND refunded_kobo IS NOT NULL
            AND released_kobo >= 0 AND refunded_kobo >= 0
            AND released_kobo + refunded_kobo = amount_kobo
            AND status = 'settled')
    );

COMMIT;
