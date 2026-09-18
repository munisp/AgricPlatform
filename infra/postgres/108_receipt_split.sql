-- 108_receipt_split.sql — V-37: warehouse receipt split (parent/child
-- receipts) — Wave-2 pack W2-C3.
--
-- Receipts were whole-only: selling half a receipted lot forced a full
-- withdraw + re-deposit. A receipt can now be SPLIT into child receipts
-- with exact quantity conservation (Σ children weight_kg/bag_count equals
-- the parent's effective, loss-adjusted quantity). The parent moves to the
-- new terminal 'split' status (non-pledgeable, non-transferable,
-- non-redeemable); each child carries parent_receipt_id + split_seq and an
-- HMAC signature chained to the parent's receipt number + signature
-- (receipt-crypto.ts RECEIPT_CHILD_PAYLOAD_VERSION).
--
--   warehouse.receipts  gains parent_receipt_id (self-FK) and split_seq,
--                       admits the 'split' status, and the one-receipt-per-
--                       deposit uniqueness becomes PARTIAL (root receipts
--                       only) so children sharing the parent's deposit do
--                       not collide.
--
-- Idempotent per repo policy (IF NOT EXISTS / DROP+ADD / pg_constraint DO
-- block). No triggers, per repo convention.

BEGIN;

ALTER TABLE warehouse.receipts
    ADD COLUMN IF NOT EXISTS parent_receipt_id text,
    ADD COLUMN IF NOT EXISTS split_seq integer;

-- Self-reference for split children (guarded: pg_constraint DO block naming
-- both the constraint and its table, per the 019a lint pattern).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_receipts_parent_fk'
    ) THEN
        ALTER TABLE warehouse.receipts
            ADD CONSTRAINT warehouse_receipts_parent_fk
            FOREIGN KEY (parent_receipt_id) REFERENCES warehouse.receipts(id);
    END IF;
END $$;

ALTER TABLE warehouse.receipts
    DROP CONSTRAINT IF EXISTS warehouse_receipts_split_seq_check;
ALTER TABLE warehouse.receipts
    ADD CONSTRAINT warehouse_receipts_split_seq_check
    CHECK (
        (parent_receipt_id IS NULL AND split_seq IS NULL)
        OR (parent_receipt_id IS NOT NULL AND split_seq IS NOT NULL AND split_seq >= 1)
    );

-- 'split' is a valid terminal status now.
ALTER TABLE warehouse.receipts
    DROP CONSTRAINT IF EXISTS receipts_status_check;
ALTER TABLE warehouse.receipts
    ADD CONSTRAINT receipts_status_check
    CHECK (status IN ('active','pledged','released','redeemed','split'));

-- One ROOT receipt per deposit (children share the parent's deposit).
DROP INDEX IF EXISTS warehouse_receipts_deposit_idx;
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_receipts_deposit_idx
    ON warehouse.receipts (deposit_id) WHERE parent_receipt_id IS NULL;
CREATE INDEX IF NOT EXISTS warehouse_receipts_parent_idx
    ON warehouse.receipts (parent_receipt_id);

COMMIT;
