-- 086_succession.sql — W2-FP1 V-09 (deceased/succession, dim04-H1).
--
-- Adds the `deceased` account status (estate frozen: sessions revoked,
-- withdrawals refuse, identity row NEVER anonymised — unlike DSAR erasure)
-- and the next-of-kin claim ledger. Claims carry the claimant/heir, the
-- relationship and an evidence reference; decisions are append-only status
-- transitions with decided_by/decided_at.
--
-- Idempotent (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT)
-- per migration policy. Additive only, no edits to merged migrations.

BEGIN;

-- Widen the account-status domain with 'deceased'.
ALTER TABLE identity.users
    DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE identity.users
    ADD CONSTRAINT users_status_check
    CHECK (status IN ('active','suspended','deactivated','pending_deletion','deceased'));

-- Next-of-kin succession claims.
CREATE TABLE IF NOT EXISTS identity.succession_claims (
    id               text PRIMARY KEY,
    deceased_user_id text NOT NULL REFERENCES identity.users(id),
    heir_user_id     text REFERENCES identity.users(id),
    claimant_name    text NOT NULL,
    claimant_phone   text,
    relationship     text NOT NULL,
    evidence_ref     text NOT NULL,
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected')),
    filed_at         timestamptz NOT NULL DEFAULT now(),
    decided_at       timestamptz,
    decided_by       text,
    decision_note    text
);

-- One open claim per estate at a time (service also guards; belt + braces).
CREATE UNIQUE INDEX IF NOT EXISTS succession_claims_open_estate_idx
    ON identity.succession_claims (deceased_user_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS succession_claims_deceased_idx
    ON identity.succession_claims (deceased_user_id);

COMMIT;
