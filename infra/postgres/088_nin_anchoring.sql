-- 088_nin_anchoring.sql — W2-FP1 V-45 (cross-programme duplicate identity,
-- dim04-H3).
--
-- Programme-level NIN dedupe (input_vouchers.beneficiaries, migration 035) is
-- per-programme only; two SIMs = two "farmers" stay invisible. This adds an
-- OPTIONAL global NIN anchor (one per user, HASH ONLY — the cleartext NIN is
-- never stored). nin_hash is deliberately NOT unique so duplicates can be
-- DETECTED by the duplicate report and resolved through the merge flow,
-- which appends to identity.account_merges.
--
-- Idempotent per migration policy. Additive only.

BEGIN;

CREATE TABLE IF NOT EXISTS identity.nin_anchors (
    id          text PRIMARY KEY,
    user_id     text NOT NULL REFERENCES identity.users(id),
    nin_hash    text NOT NULL,                 -- sha256('nin-anchor:' + nin)
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged')),
    anchored_at timestamptz NOT NULL DEFAULT now(),
    anchored_by text NOT NULL
);

-- One anchor per user.
CREATE UNIQUE INDEX IF NOT EXISTS nin_anchors_user_idx
    ON identity.nin_anchors (user_id);

-- Duplicate detection: group by nin_hash, count(distinct user_id) > 1.
CREATE INDEX IF NOT EXISTS nin_anchors_hash_idx
    ON identity.nin_anchors (nin_hash);

CREATE TABLE IF NOT EXISTS identity.account_merges (
    id                     text PRIMARY KEY,
    primary_user_id        text NOT NULL REFERENCES identity.users(id),
    duplicate_user_id      text NOT NULL REFERENCES identity.users(id),
    credit_loans_moved     integer NOT NULL DEFAULT 0,
    loan_applications_moved integer NOT NULL DEFAULT 0,
    merged_at              timestamptz NOT NULL DEFAULT now(),
    merged_by              text NOT NULL,
    note                   text
);

CREATE INDEX IF NOT EXISTS account_merges_primary_idx
    ON identity.account_merges (primary_user_id);
CREATE INDEX IF NOT EXISTS account_merges_duplicate_idx
    ON identity.account_merges (duplicate_user_id);

COMMIT;
