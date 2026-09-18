-- 101_agent_voucher_liability.sql — W2-C2 paid agent-voucher liability
-- (V-33; agent_banking schema).
-- Agent-issued vouchers are bought with cash but previously left NO ledger
-- trace until redemption, and expiry stranded the farmer's cash. Issuance now
-- posts DR agent float / CR agent:<id>:voucher_liability (cash received +
-- refundable obligation) cross-referenced by issuance_ledger_entry_id;
-- redemption settles the liability (settle_ledger_entry_id); expiry of an
-- unredeemed paid voucher reclassifies the obligation to
-- agent:<id>:refunds_payable (refund_status NONE→PAYABLE) so it is visible in
-- the agent settlement, and the cash hand-back posts PAYABLE→PAID.
-- Re-apply-safe per scripts/lint-migrations.mjs.

BEGIN;

ALTER TABLE agent_banking.vouchers
    ADD COLUMN IF NOT EXISTS issuance_ledger_entry_id text;
ALTER TABLE agent_banking.vouchers
    ADD COLUMN IF NOT EXISTS settle_ledger_entry_id text;

-- NONE (legacy/no liability) | PAYABLE (expired unredeemed, refund owed to
-- the farmer) | PAID (cash hand-back confirmed).
ALTER TABLE agent_banking.vouchers
    ADD COLUMN IF NOT EXISTS refund_status text NOT NULL DEFAULT 'NONE';
ALTER TABLE agent_banking.vouchers
    ADD COLUMN IF NOT EXISTS refund_ledger_entry_id text;
ALTER TABLE agent_banking.vouchers
    ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

-- Operator/agent settlement queue scan: expired paid vouchers awaiting refund.
CREATE INDEX IF NOT EXISTS agent_banking_vouchers_refund_idx
    ON agent_banking.vouchers (agent_id, refund_status)
    WHERE refund_status = 'PAYABLE';

COMMIT;
