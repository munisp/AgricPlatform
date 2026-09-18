-- 103_agent_deregistration.sql — W2-C2 agent exit / close-out settlement
-- (V-40; agent_banking schema).
-- Agent lifecycle gains DEREGISTERING → DEREGISTERED: the close-out sweeps
-- the float to zero with balanced legs (DR agent float / CR platform:cash),
-- settles accrued commission payable, and records a voucher honour-or-refund
-- grace window (voucher_grace_until) during which pre-issued vouchers remain
-- redeemable while cash-in/out and new issuance stay blocked.
-- Re-apply-safe per scripts/lint-migrations.mjs.

BEGIN;

ALTER TABLE agent_banking.agents
    ADD COLUMN IF NOT EXISTS deregistered_at timestamptz;
ALTER TABLE agent_banking.agents
    ADD COLUMN IF NOT EXISTS voucher_grace_until timestamptz;
ALTER TABLE agent_banking.agents
    ADD COLUMN IF NOT EXISTS deregistration_reason text;

COMMIT;
