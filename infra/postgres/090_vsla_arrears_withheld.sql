-- 090_vsla_arrears_withheld.sql — FP-2 W2 V-10 (share-out net of arrears).
--
-- Close-cycle share-outs now withhold the borrower's outstanding DEFAULTED-
-- loan arrears from their gross pro-rata share and apply them against the
-- loans_receivable claim instead of paying cash. The withheld amount is
-- persisted on BOTH the plan rows (crash-resume replays the same netting)
-- and the paid share-out rows (audit). Status columns are plain text with
-- documented value sets (no CHECK constraints), so DEFAULTED/WRITTEN_OFF
-- need no DDL.
--
-- Idempotent per migration policy. No triggers, additive only, no edits to
-- merged migrations.

BEGIN;

ALTER TABLE vsla_carbon.vsla_share_out_plan
    ADD COLUMN IF NOT EXISTS arrears_withheld_kobo bigint NOT NULL DEFAULT 0;

ALTER TABLE vsla_carbon.vsla_share_outs
    ADD COLUMN IF NOT EXISTS arrears_withheld_kobo bigint NOT NULL DEFAULT 0;

COMMIT;
