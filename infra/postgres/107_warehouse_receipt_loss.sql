-- 107_warehouse_receipt_loss.sql — V-07: spoilage/condition loss of
-- receipted grain (Wave-2 pack W2-C3).
--
-- Issued e-WHRs previously had no loss path: a receipt on destroyed/spoiled
-- grain stayed claimable at full value. Receipts now carry cumulative loss
-- fields — the SIGNED issuance payload (weight_kg, bag_count, grade) is
-- never rewritten (that would break the HMAC tamper evidence), so the
-- effective claim quantity is weight_kg - lost_weight_kg and the effective
-- grade is COALESCE(regraded_to, grade). The append-only evidence trail is
-- the outbox event warehouse.receipt.loss_reported; the LTV guardian
-- subscribes and writes down collateral positions (margin-call trigger),
-- and the collateral-claim path applies the loss haircut.
--
--   warehouse.receipts  gains lost_weight_kg, lost_bag_count, regraded_to.
--
-- Idempotent per repo policy (IF NOT EXISTS / DROP+ADD constraint). No
-- triggers, per repo convention.

BEGIN;

ALTER TABLE warehouse.receipts
    ADD COLUMN IF NOT EXISTS lost_weight_kg double precision,
    ADD COLUMN IF NOT EXISTS lost_bag_count integer,
    ADD COLUMN IF NOT EXISTS regraded_to text;

ALTER TABLE warehouse.receipts
    DROP CONSTRAINT IF EXISTS warehouse_receipts_loss_check;
ALTER TABLE warehouse.receipts
    ADD CONSTRAINT warehouse_receipts_loss_check
    CHECK (
        (lost_weight_kg IS NULL OR (lost_weight_kg >= 0 AND lost_weight_kg <= weight_kg))
        AND (lost_bag_count IS NULL OR (lost_bag_count >= 0 AND lost_bag_count <= bag_count))
        AND (regraded_to IS NULL OR regraded_to IN ('A','B','C'))
    );

COMMIT;
