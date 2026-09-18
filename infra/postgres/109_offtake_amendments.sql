-- 109_offtake_amendments.sql — V-34 offtake renegotiation (versioned
-- contract amendments) + V-35 buyer-default remedy fields (Wave-2 pack
-- W2-C3).
--
-- V-34: the 'renegotiation required' event previously had no state to land
-- in. marketplace.offtake_amendments stores proposed/accepted/rejected
-- amendment rounds (price band, window end, open-milestone due dates); the
-- contract row gains terms_version, bumped on every ACCEPTED amendment
-- (propose → counterparty accept). The missed/defaulted sweep reads the
-- AMENDED window_end / due dates, so renegotiated deadlines are respected.
--
-- V-35: a defaulted contract now books a penalty receivable
-- (default_penalty_kobo; ledger journal DR coop default_penalty_receivable
-- / CR org default_penalty_payable — collection rides the payout rail
-- behind the existing fail-closed stubs, E-01 gate) and records the
-- assisted re-marketing listing created for the stranded lot
-- (remarketed_listing_id).
--
-- Idempotent per repo policy (IF NOT EXISTS / DROP+ADD constraint). No
-- triggers, per repo convention. Money is integer kobo.

BEGIN;

CREATE TABLE IF NOT EXISTS marketplace.offtake_amendments (
    id                    text PRIMARY KEY,
    contract_id           text NOT NULL REFERENCES marketplace.offtake_contracts(id),
    seq                   integer NOT NULL CHECK (seq >= 1),
    status                text NOT NULL CHECK (status IN ('proposed','accepted','rejected','superseded')),
    price_band            jsonb,                 -- absent = band unchanged
    window_end            date,                  -- absent = window unchanged
    milestone_due_dates   jsonb,                 -- [{seq, dueDate}], open milestones only
    note                  text,
    proposed_by           text NOT NULL,
    created_at            timestamptz NOT NULL,
    decided_at            timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS offtake_amendments_contract_seq_idx
    ON marketplace.offtake_amendments (contract_id, seq);
-- At most ONE open proposal per contract (a new proposal supersedes).
CREATE UNIQUE INDEX IF NOT EXISTS offtake_amendments_one_proposed_idx
    ON marketplace.offtake_amendments (contract_id) WHERE status = 'proposed';

ALTER TABLE marketplace.offtake_contracts
    ADD COLUMN IF NOT EXISTS terms_version integer,
    ADD COLUMN IF NOT EXISTS default_penalty_kobo bigint,
    ADD COLUMN IF NOT EXISTS remarketed_listing_id text;

ALTER TABLE marketplace.offtake_contracts
    DROP CONSTRAINT IF EXISTS offtake_contracts_terms_version_check;
ALTER TABLE marketplace.offtake_contracts
    ADD CONSTRAINT offtake_contracts_terms_version_check
    CHECK (terms_version IS NULL OR terms_version >= 1);

ALTER TABLE marketplace.offtake_contracts
    DROP CONSTRAINT IF EXISTS offtake_contracts_default_penalty_check;
ALTER TABLE marketplace.offtake_contracts
    ADD CONSTRAINT offtake_contracts_default_penalty_check
    CHECK (default_penalty_kobo IS NULL OR default_penalty_kobo >= 0);

COMMIT;
