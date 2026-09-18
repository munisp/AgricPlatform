-- 084_vsla_repayment_payload_hash.sql — FP-2 V-57 (repay idempotency-consistency).
--
-- The VSLA repayLoan path replayed a client idempotency key WITHOUT asserting
-- the payload: the same key with a different amount silently returned the
-- original repayment. Following the 074 contribution/top-up/voucher doctrine,
-- repayment rows now carry a canonical payload fingerprint at insert time;
-- the service replays on hash equality and fails closed with 409
-- IDEMPOTENCY_PAYLOAD_MISMATCH on divergence. Nullable so pre-081 rows
-- replay as legacy records. The same migration wave also rejects
-- overpayments instead of silently clamping them (service-side; no DDL).
--
-- Idempotent (IF NOT EXISTS) per migration policy. No triggers, additive
-- only, no edits to merged migrations.

BEGIN;

ALTER TABLE vsla_carbon.vsla_loan_repayments
    ADD COLUMN IF NOT EXISTS payload_hash text;

COMMIT;
