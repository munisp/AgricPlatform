-- 054_agent_daily_limits.sql — Stage 27 WP-G2 (V2 funds-atomicity audit,
-- A1-7): atomic per-agent daily cash-limit counters.
--
-- The agent daily cash-in/out cap (agents.daily_limit_kobo) was enforced
-- check-then-act: AgentBankingService summed the day's
-- agent_banking.transactions rows and compared against the cap BEFORE
-- posting to the ledger, with no lock or atomic counter in between.
-- Concurrent cash requests all observed the same pre-sum and all posted,
-- breaching the cap (the solvency guards still prevented overdraft — this
-- was a fraud/AML velocity-control bypass, not money creation).
--
-- This table holds one usage counter per (agent, UTC business date). The
-- reservation is an atomic conditional upsert executed INSIDE the ledger
-- posting transaction (PgLedgerEntryRepository.postEntry):
--
--   INSERT INTO agent_banking.agent_daily_limits (...)
--   SELECT ... WHERE amount <= limit
--   ON CONFLICT (agent_id, business_date) DO UPDATE
--     SET used_amount_kobo = used_amount_kobo + EXCLUDED.used_amount_kobo
--     WHERE used_amount_kobo + EXCLUDED.used_amount_kobo <= limit
--   RETURNING used_amount_kobo
--
-- Zero rows returned means the cap would be breached and the whole posting
-- rolls back; a posting failure after the reservation releases it via the
-- same rollback. The primary-key row lock serialises concurrent same-day
-- requests for an agent, so the cap can never be exceeded.
--
-- Idempotent (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS) per migration
-- policy. No triggers — updated_at is maintained by the upsert, per repo
-- convention.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_banking.agent_daily_limits (
    agent_id          text NOT NULL REFERENCES agent_banking.agents(id),
    business_date     date NOT NULL,
    used_amount_kobo  bigint NOT NULL,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, business_date)
);

ALTER TABLE agent_banking.agent_daily_limits
    DROP CONSTRAINT IF EXISTS agent_daily_limits_used_nonnegative;
ALTER TABLE agent_banking.agent_daily_limits
    ADD CONSTRAINT agent_daily_limits_used_nonnegative
    CHECK (used_amount_kobo >= 0);

COMMIT;
