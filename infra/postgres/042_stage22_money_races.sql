-- 042_stage22_money_races.sql — Stage 22 money-path race hardening
-- (audit C1-6 / C2-9 / C2-10; assumes 041 from PR #35 applied first).
--
-- 1. agent_banking.float_topups gains a client idempotency_key (C2-9).
--    requestTopUp previously inserted unconditionally while settlement is
--    idempotent per top-up id, so a transport retry created TWO settleable
--    rows. The key is mandatory at the API layer (controller DTO); this
--    migration adds the column NULLABLE with a partial UNIQUE index
--    (WHERE idempotency_key IS NOT NULL), mirroring
--    038_agent_voucher_idempotency.sql. NULL-handling: rows that predate
--    this migration keep idempotency_key = NULL forever (they are already
--    REQUESTED/APPROVED/SETTLED operational history); NULLs are exempt from
--    uniqueness so legacy rows never collide, and the API never writes new
--    NULL keys. No NOT NULL constraint is added precisely because of those
--    legacy rows.
--
-- 2. Voucher status vocabularies gain pending states (C1-6 / C3 / C2-9).
--    input_vouchers.vouchers.status now also uses REDEEMING / EXPIRING /
--    VOIDING, and agent_banking.vouchers.status uses REDEEMING: the
--    compare-and-set into the pending state happens BEFORE the ledger
--    posting so a redeem vs expire/void race can no longer double-debit the
--    programme liability or pay out against a voided voucher. Both columns
--    are plain text with comment-only vocabularies (no CHECK constraints
--    exist in 032/035), so no DDL is required — this section documents the
--    extended vocabularies:
--      input_vouchers.vouchers.status:
--        ISSUED | REDEEMING | REDEEMED | EXPIRING | EXPIRED | VOIDING | VOIDED
--      agent_banking.vouchers.status:
--        ISSUED | REDEEMING | REDEEMED | EXPIRED | VOIDED
--    agent_banking.vouchers.idempotency_key stays OPTIONAL in the schema
--    (038's partial UNIQUE index unchanged); it is now enforced as REQUIRED
--    at the API layer for new issuance (C2-10) — no NOT NULL here because
--    legacy keyless rows exist.
--
-- Idempotent (IF NOT EXISTS throughout) per migration policy. No triggers,
-- per repo convention.

BEGIN;

ALTER TABLE agent_banking.float_topups
    ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS agent_banking_float_topups_idempotency_key_uq
    ON agent_banking.float_topups (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

COMMIT;
