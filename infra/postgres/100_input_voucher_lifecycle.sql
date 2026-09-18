-- 100_input_voucher_lifecycle.sql — W2-C2 voucher lifecycle (V-02 refund /
-- reversal, V-32 partial redemption; input_vouchers schema).
-- Balance-bearing vouchers: vouchers carry redeemed_amount_kobo /
-- pending_amount_kobo so the face value can be redeemed in parts
-- (ISSUED/PARTIALLY_REDEEMED → REDEEMING → PARTIALLY_REDEEMED|REDEEMED), and
-- a redeemed voucher can be refunded (REDEEMED/PARTIALLY_REDEEMED → REFUNDING
-- → REFUNDED) with compensating balanced ledger entries and an optional
-- complaint-case reference. Redemptions become per-part rows: the hard
-- anti-double-spend constraint moves from UNIQUE voucher_id to
-- UNIQUE (voucher_id, part_seq).
-- All statements are idempotent / re-apply-safe per scripts/lint-migrations.mjs.

BEGIN;

-- ------------------------------------------------------------ vouchers
ALTER TABLE input_vouchers.vouchers
    ADD COLUMN IF NOT EXISTS redeemed_amount_kobo bigint NOT NULL DEFAULT 0;

-- Face value may never be over-redeemed (V-32: overshoot rejected at the
-- storage layer too, not only in the service CAS).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vouchers_redeemed_lte_face') THEN
        ALTER TABLE input_vouchers.vouchers
            ADD CONSTRAINT vouchers_redeemed_lte_face
            CHECK (redeemed_amount_kobo <= amount_kobo);
    END IF;
END $$;

-- In-flight redemption part amount while status = REDEEMING (set by the
-- claim CAS so a crash-resume finalizes with the claimed amount).
ALTER TABLE input_vouchers.vouchers
    ADD COLUMN IF NOT EXISTS pending_amount_kobo bigint;

-- V-02 refund bookkeeping: refunded_at/refunded_amount_kobo mark the
-- REDEEMED→REFUNDED terminal transition; complaint_case_id links the refund
-- to the complaint/dispute case that triggered it (downstream case modules
-- subscribe to inputvouchers.voucher.refunded).
ALTER TABLE input_vouchers.vouchers
    ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE input_vouchers.vouchers
    ADD COLUMN IF NOT EXISTS refunded_amount_kobo bigint;
ALTER TABLE input_vouchers.vouchers
    ADD COLUMN IF NOT EXISTS refund_reason text;
ALTER TABLE input_vouchers.vouchers
    ADD COLUMN IF NOT EXISTS complaint_case_id text;

-- ---------------------------------------------------------- redemptions
-- Per-part redemption rows (V-32): part_seq starts at 1; the first (or only,
-- full-face) redemption keeps the legacy idempotency key
-- input-voucher-redemption:<voucherId>.
ALTER TABLE input_vouchers.redemptions
    ADD COLUMN IF NOT EXISTS part_seq integer NOT NULL DEFAULT 1;

-- The single-redemption UNIQUE(voucher_id) constraint gives way to
-- UNIQUE(voucher_id, part_seq). The original constraint was declared inline
-- in 035, so Postgres auto-named it redemptions_voucher_id_key.
ALTER TABLE input_vouchers.redemptions
    DROP CONSTRAINT IF EXISTS redemptions_voucher_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS input_vouchers_redemptions_voucher_part_idx
    ON input_vouchers.redemptions (voucher_id, part_seq);

COMMIT;
