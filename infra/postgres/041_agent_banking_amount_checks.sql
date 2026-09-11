-- 041_agent_banking_amount_checks.sql — Stage 21 mission-critical assurance
-- audit, staged fix A: positivity constraints on agent-banking money columns.
--
-- agent_banking.float_topups.amount_kobo, agent_banking.vouchers.amount_kobo,
-- and agent_banking.transactions.amount_kobo were created in 032 without CHECK
-- constraints, so the database would accept zero or negative amounts if
-- application-level validation were ever bypassed (buggy caller, direct SQL,
-- future code path). The ledger remains the source of truth for value; these
-- CHECKs are the defence-in-depth floor for the operational records.
--
-- commission_kobo keeps its existing semantics: 0 is a legitimate commission
-- (e.g. cash-in with no commission configured), so it is constrained to
-- >= 0 rather than > 0.
--
-- Idempotent per migration policy (DROP CONSTRAINT IF EXISTS before ADD,
-- matching the pattern established in 016_funds_hardening.sql).

BEGIN;

ALTER TABLE agent_banking.float_topups
    DROP CONSTRAINT IF EXISTS float_topups_amount_positive;
ALTER TABLE agent_banking.float_topups
    ADD CONSTRAINT float_topups_amount_positive
    CHECK (amount_kobo > 0);

ALTER TABLE agent_banking.vouchers
    DROP CONSTRAINT IF EXISTS vouchers_amount_positive;
ALTER TABLE agent_banking.vouchers
    ADD CONSTRAINT vouchers_amount_positive
    CHECK (amount_kobo > 0);

ALTER TABLE agent_banking.transactions
    DROP CONSTRAINT IF EXISTS transactions_amount_positive;
ALTER TABLE agent_banking.transactions
    ADD CONSTRAINT transactions_amount_positive
    CHECK (amount_kobo > 0);
ALTER TABLE agent_banking.transactions
    DROP CONSTRAINT IF EXISTS transactions_commission_nonnegative;
ALTER TABLE agent_banking.transactions
    ADD CONSTRAINT transactions_commission_nonnegative
    CHECK (commission_kobo >= 0);

COMMIT;
