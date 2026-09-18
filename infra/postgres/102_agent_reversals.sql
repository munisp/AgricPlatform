-- 102_agent_reversals.sql — W2-C2 agent transaction reversal/adjustment
-- instrument (V-08; agent_banking schema).
-- Rogue-agent fake deposits were irreversible: AGENT_TRANSACTION_TYPES had no
-- reversal type and fraud-case resolution moved no money. Reversals are a
-- maker-checker workflow (initiator ≠ approver): a PENDING reversal row is
-- created first; an admin OTHER than the initiator approves, posting the
-- exact inverse ledger entry (flipped directions, reverses_transfer_id set)
-- plus a compensating commission entry and a same-transaction correction of
-- the daily-limit counter. The resulting operational record is a
-- transactions row of type 'reversal' linked back via
-- reversal_of_transaction_id, with optional fraud_case_id linkage.
-- Re-apply-safe per scripts/lint-migrations.mjs.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_banking.reversals (
    id                      text PRIMARY KEY,
    agent_id                text NOT NULL REFERENCES agent_banking.agents(id),
    transaction_id          text NOT NULL REFERENCES agent_banking.transactions(id),
    amount_kobo             bigint NOT NULL,
    reason                  text NOT NULL,
    -- Optional link to the fraud case that authorised this reversal
    -- (fraud.sentinel_cases id); recorded + emitted on the reversal event.
    fraud_case_id           text,
    status                  text NOT NULL DEFAULT 'PENDING',  -- PENDING | APPROVED | POSTED | REJECTED
    initiated_by            text NOT NULL,
    decided_by              text,
    decided_at              timestamptz,
    ledger_entry_id         text,
    reversal_transaction_id text,
    idempotency_key         text NOT NULL UNIQUE,
    created_at              timestamptz NOT NULL DEFAULT now()
);

-- One live reversal per original transaction: a second initiate for the same
-- transaction conflicts instead of double-reversing. REJECTED rows release
-- the slot so a fresh, corrected reversal can be initiated.
CREATE UNIQUE INDEX IF NOT EXISTS agent_banking_reversals_tx_live_idx
    ON agent_banking.reversals (transaction_id)
    WHERE status IN ('PENDING', 'APPROVED', 'POSTED');

CREATE INDEX IF NOT EXISTS agent_banking_reversals_agent_idx
    ON agent_banking.reversals (agent_id, status);

-- Reversal/adjustment operational rows in the transaction log: type
-- 'reversal', linked to the reversed transaction and (optionally) the fraud
-- case. commission_kobo on a reversal row is the NEGATIVE of the reversed
-- accrual so statement sums net out.
ALTER TABLE agent_banking.transactions
    ADD COLUMN IF NOT EXISTS reversal_of_transaction_id text;
ALTER TABLE agent_banking.transactions
    ADD COLUMN IF NOT EXISTS fraud_case_id text;

CREATE INDEX IF NOT EXISTS agent_banking_transactions_reversal_of_idx
    ON agent_banking.transactions (reversal_of_transaction_id)
    WHERE reversal_of_transaction_id IS NOT NULL;

COMMIT;
