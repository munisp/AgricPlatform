-- 021_compliance.sql — NDPA (Nigeria Data Protection Act 2023) readiness
-- tooling (Wave COMP). Numbered 021: 019/019a are applied and 020 is
-- reserved by a parallel wave.
--
--   1. compliance.consent_records        versioned consent capture (purpose +
--                                        policy version + source), revocable.
--   2. compliance.data_subject_requests  NDPA s.37 export / s.38 erasure
--                                        workflow (pending → processing →
--                                        completed | rejected).
--   3. compliance.retention_policies     per-entity retention rules consumed
--                                        by the endpoint-driven sweeper
--                                        (POST /compliance/retention/sweep).
--
-- These tables are TOOLING for a qualified Nigerian DPO/lawyer to operate;
-- nothing here constitutes legal sign-off. Idempotent per migration policy:
-- safe to re-run.

BEGIN;

CREATE SCHEMA IF NOT EXISTS compliance;

-- ---------------------------------------------------------------------------
-- consent_records: one row per consent decision (grant; revocation stamps
-- revoked_at on the latest active row — the history is append-only).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compliance.consent_records (
    id             text PRIMARY KEY,
    user_id        text NOT NULL,
    purpose        text NOT NULL,
    policy_version text NOT NULL,
    granted_at     timestamptz NOT NULL DEFAULT now(),
    revoked_at     timestamptz,
    source         text NOT NULL DEFAULT 'api'
);

CREATE INDEX IF NOT EXISTS compliance_consent_user_idx
    ON compliance.consent_records (user_id);
CREATE INDEX IF NOT EXISTS compliance_consent_revoked_idx
    ON compliance.consent_records (revoked_at)
    WHERE revoked_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- data_subject_requests: export requests complete synchronously (result_ref
-- carries the sha256 of the export payload); erasure requests stay pending
-- until an admin approves (anonymisation) or rejects (note required).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compliance.data_subject_requests (
    id           text PRIMARY KEY,
    user_id      text NOT NULL,
    type         text NOT NULL CHECK (type IN ('export', 'erasure')),
    status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'completed', 'rejected')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    result_ref   text,
    note         text
);

CREATE INDEX IF NOT EXISTS compliance_dsr_user_idx
    ON compliance.data_subject_requests (user_id);
CREATE INDEX IF NOT EXISTS compliance_dsr_status_idx
    ON compliance.data_subject_requests (status);

-- ---------------------------------------------------------------------------
-- retention_policies: entity-keyed rules. anonymize_not_delete = true
-- pseudonymises the user reference (financial/audit-safe); false hard-purges
-- rows past retain_days. Defaults below mirror
-- docs/compliance/retention-policy.md — a qualified DPO must review them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compliance.retention_policies (
    entity               text PRIMARY KEY,
    retain_days          integer NOT NULL CHECK (retain_days > 0),
    anonymize_not_delete boolean NOT NULL DEFAULT true,
    updated_at           timestamptz NOT NULL DEFAULT now()
);

INSERT INTO compliance.retention_policies (entity, retain_days, anonymize_not_delete)
VALUES
    ('compliance.consent_records', 730, true),
    ('compliance.data_subject_requests', 1095, true),
    ('notifications.messages', 365, false)
ON CONFLICT (entity) DO NOTHING;

COMMIT;
