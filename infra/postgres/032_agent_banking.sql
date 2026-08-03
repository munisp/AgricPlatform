-- 032_agent_banking.sql — wave AGENTBANK "Agent Banking" (agent_banking schema).
-- Rural agent float + farmer cash-in/cash-out + signed offline vouchers.
-- Money movement is NOT stored here: every value transfer posts through the
-- double-entry ledger (finance schema, wave P2a). These tables hold the
-- operational records (agent registry, float top-up workflow, vouchers,
-- transaction log) that reference ledger journal entries by id.
-- All statements are idempotent (IF NOT EXISTS) so the migration is safe to
-- re-apply. No triggers — updated_at is maintained by application code,
-- per repo convention.

BEGIN;

CREATE SCHEMA IF NOT EXISTS agent_banking;

-- Banking-agent registry. One row per enrolled agent; links an existing
-- identity.users account (role 'agent') to the organisation/cooperative it
-- operates under. float_account_code is the agent's ledger sub-account
-- (agent:<id>:float) — the float is a ledger concept, not a parallel store.
CREATE TABLE IF NOT EXISTS agent_banking.agents (
    id                          text PRIMARY KEY,
    user_id                     text NOT NULL REFERENCES identity.users(id),
    organisation                text NOT NULL,
    status                      text NOT NULL DEFAULT 'PENDING',  -- PENDING | ACTIVE | SUSPENDED
    float_account_code          text NOT NULL UNIQUE,
    commission_account_code     text NOT NULL UNIQUE,
    daily_limit_kobo            bigint NOT NULL,
    low_float_threshold_kobo    bigint NOT NULL,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_banking_agents_user_idx
    ON agent_banking.agents (user_id);

CREATE INDEX IF NOT EXISTS agent_banking_agents_status_idx
    ON agent_banking.agents (status);

-- Float top-up workflow: agent requests float, a supervisor/admin approves,
-- and settlement posts the ledger entry (platform:cash → agent float).
CREATE TABLE IF NOT EXISTS agent_banking.float_topups (
    id                  text PRIMARY KEY,
    agent_id            text NOT NULL REFERENCES agent_banking.agents(id),
    amount_kobo         bigint NOT NULL,
    status              text NOT NULL DEFAULT 'REQUESTED',  -- REQUESTED | APPROVED | SETTLED | REJECTED
    requested_by        text NOT NULL,
    decided_by          text,
    decided_at          timestamptz,
    settled_at          timestamptz,
    ledger_entry_id     text,
    rejection_reason    text,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_banking_topups_agent_idx
    ON agent_banking.float_topups (agent_id, status);

-- Signed offline vouchers. The HMAC-SHA256 signature covers
-- {voucherId, agentId, farmerId, amount, expiry, nonce} with a server-side
-- secret; verification happens server-side only. Redemption posts the
-- ledger entry atomically (idempotency key voucher-redemption:<id>).
CREATE TABLE IF NOT EXISTS agent_banking.vouchers (
    id                  text PRIMARY KEY,
    agent_id            text NOT NULL REFERENCES agent_banking.agents(id),
    farmer_id           text NOT NULL REFERENCES identity.users(id),
    amount_kobo         bigint NOT NULL,
    expires_at          timestamptz NOT NULL,
    nonce               text NOT NULL,
    signature           text NOT NULL,
    status              text NOT NULL DEFAULT 'ISSUED',  -- ISSUED | REDEEMED | EXPIRED | VOIDED
    redeemed_at         timestamptz,
    ledger_entry_id     text,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_banking_vouchers_agent_idx
    ON agent_banking.vouchers (agent_id, status);

CREATE INDEX IF NOT EXISTS agent_banking_vouchers_farmer_idx
    ON agent_banking.vouchers (farmer_id);

-- Agent transaction log (cash-in / cash-out / voucher redemption). The
-- ledger entry is the source of truth for value; this row is the
-- operational record (farmer presence proof reference, commission accrual).
-- idempotency_key is UNIQUE so transport retries cannot double-post.
CREATE TABLE IF NOT EXISTS agent_banking.transactions (
    id                  text PRIMARY KEY,
    agent_id            text NOT NULL REFERENCES agent_banking.agents(id),
    farmer_id           text NOT NULL REFERENCES identity.users(id),
    type                text NOT NULL,           -- cash_in | cash_out | voucher_redemption
    amount_kobo         bigint NOT NULL,
    commission_kobo     bigint NOT NULL DEFAULT 0,
    idempotency_key     text NOT NULL UNIQUE,
    ledger_entry_id     text NOT NULL,
    voucher_id          text REFERENCES agent_banking.vouchers(id),
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_banking_transactions_agent_idx
    ON agent_banking.transactions (agent_id, created_at);

CREATE INDEX IF NOT EXISTS agent_banking_transactions_farmer_idx
    ON agent_banking.transactions (farmer_id, created_at);

COMMIT;
