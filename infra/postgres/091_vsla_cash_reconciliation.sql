-- 091_vsla_cash_reconciliation.sql — FP-2 W2 V-48 (cash box vs ledger).
--
-- VSLAs keep a physical lockbox between meetings while the platform models
-- every movement as a ledger posting — previously with NO reconciliation
-- instrument, so a treasurer skim was a permanent unexplained divergence.
-- This adds:
--   meetings     — the VSLA governance anchor (attendance/fine rules later).
--   cash_counts  — dual-attested cash-count declarations: the treasurer
--                  (group admin) declares the physical count (PENDING), a
--                  DIFFERENT active member attests; attestation captures the
--                  ledger balance, computes the variance and posts a
--                  variance adjustment entry (ledger_entry_id). FLAGGED when
--                  the variance exceeds the service threshold (audited).
-- Statuses are plain text with documented value sets (no CHECK constraints),
-- matching the 037 style. Idempotent per migration policy. No triggers,
-- additive only, no edits to merged migrations.

BEGIN;

CREATE TABLE IF NOT EXISTS vsla_carbon.meetings (
    id          text PRIMARY KEY,
    group_id    text NOT NULL REFERENCES vsla_carbon.vsla_groups(id),
    held_at     timestamptz NOT NULL,
    notes       text,
    created_by  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vsla_meetings_group_idx
    ON vsla_carbon.meetings (group_id);

CREATE TABLE IF NOT EXISTS vsla_carbon.cash_counts (
    id              text PRIMARY KEY,
    group_id        text NOT NULL REFERENCES vsla_carbon.vsla_groups(id),
    meeting_id      text REFERENCES vsla_carbon.meetings(id),
    declared_kobo   bigint NOT NULL CHECK (declared_kobo >= 0),
    ledger_kobo     bigint,
    variance_kobo   bigint,
    declared_by     text NOT NULL,
    attested_by     text,
    status          text NOT NULL DEFAULT 'PENDING',  -- PENDING | ATTESTED | FLAGGED
    idempotency_key text NOT NULL UNIQUE,
    ledger_entry_id text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    attested_at     timestamptz
);

CREATE INDEX IF NOT EXISTS vsla_cash_counts_group_idx
    ON vsla_carbon.cash_counts (group_id);

CREATE INDEX IF NOT EXISTS vsla_cash_counts_status_idx
    ON vsla_carbon.cash_counts (status);

COMMIT;
