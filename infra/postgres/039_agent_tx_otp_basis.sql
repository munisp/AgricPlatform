-- 039_agent_tx_otp_basis.sql — wave AGENTBANK OTP basis honesty.
-- Cash transactions verified a farmer presence proof (OTP) but recorded no
-- basis for it: the deterministic stub OTP driver (publicly computable code,
-- non-production only) and a live OTP were indistinguishable in the record.
-- Adds a nullable otp_basis column ('stub' | 'live'; NULL for voucher
-- redemptions and legacy rows) so every cash movement carries the basis of
-- the proof that authorised it.
-- Idempotent per migration policy (IF NOT EXISTS). No triggers, per repo
-- convention.

BEGIN;

ALTER TABLE agent_banking.transactions
    ADD COLUMN IF NOT EXISTS otp_basis text;

COMMIT;
