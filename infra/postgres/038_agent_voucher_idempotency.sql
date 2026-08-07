-- 038_agent_voucher_idempotency.sql — wave AGENTBANK voucher idempotency.
-- issueVoucher was the only money-path operation without a client idempotency
-- key: a USSD/API transport retry of voucher issuance created a DUPLICATE
-- voucher. Adds an optional idempotency_key to agent_banking.vouchers with a
-- partial UNIQUE index (NULLs allowed — legacy/keyless issuance stays valid)
-- so retries replay the original voucher instead of duplicating it.
-- Idempotent per migration policy (IF NOT EXISTS). No triggers, per repo
-- convention.

BEGIN;

ALTER TABLE agent_banking.vouchers
    ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS agent_banking_vouchers_idempotency_key_uq
    ON agent_banking.vouchers (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

COMMIT;
