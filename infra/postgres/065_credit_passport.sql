-- ---------------------------------------------------------------------------
-- Stage 27 INNOVATION 7: Credit Passport — portable, verifiable farmer
-- credit credential (schema `credit_passport`).
--
-- The passport COMPOSES existing domains at read time (credit repayment
-- history, VSLA discipline, learning certificates, the shadow geo credit
-- factor) — those source tables stay in their own schemas and are never
-- copied here. This schema stores only:
--   1. credentials — the append-only per-farmer credential chain. Every
--      recompute on material change appends a NEW version row whose
--      prev_hash links to the superseded version's payload_hash (sha256
--      over canonical JSON, genesis = 64 zeroes — the platform-wide
--      traceability convention, no DB triggers). At most ONE credential
--      per user is 'active' (partial unique index below); superseded
--      versions keep their rows so history is tamper-evident.
--   2. disclosures — consent-scoped, expiring grants that let a named
--      partner read a specific credential version through the partner API
--      (NDPA consent recorded at share time).
-- Idempotent: CREATE … IF NOT EXISTS throughout; safe to re-apply.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE SCHEMA IF NOT EXISTS credit_passport;

-- Credential chain anchor. passport_code is the public, HMAC-signed
-- verification code (livestock-passport pattern): payload (credential id +
-- user id + nonce) signed with CREDIT_PASSPORT_SECRET, so forged codes fail
-- verification server-side. The raw HMAC signature is stored alongside for
-- constant-time re-verification. payload carries the composed sections with
-- per-section honesty basis badges (repayment LIVE, certificates LIVE,
-- VSLA LIVE, geo factor SHADOW + non-decisional); payload_hash + prev_hash
-- form the per-farmer append-only chain.
CREATE TABLE IF NOT EXISTS credit_passport.credentials (
    id                  text PRIMARY KEY,           -- crp-{uuid}
    user_id             text NOT NULL REFERENCES identity.users(id),
    version             integer NOT NULL CHECK (version >= 1),
    payload             jsonb NOT NULL,
    payload_hash        text NOT NULL UNIQUE,       -- sha256 canonical payload
    prev_hash           text NOT NULL,              -- chain link (genesis = 64 zeroes)
    passport_code       text NOT NULL UNIQUE,       -- CRP.{credentialId}.{nonce}.{sig16}
    code_nonce          text NOT NULL,
    code_signature      text NOT NULL,              -- HMAC-SHA256 hex (64)
    -- 'active' = current head; 'superseded' = a newer version exists;
    -- 'revoked' = farmer/admin invalidated the credential (terminal).
    status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','superseded','revoked')),
    issued_by           text NOT NULL,
    issued_at           timestamptz NOT NULL DEFAULT now(),
    revoked_at          timestamptz,
    UNIQUE (user_id, version)
);
-- One ACTIVE credential per user (the current chain head). Superseded and
-- revoked versions are retained for the append-only chain.
CREATE UNIQUE INDEX IF NOT EXISTS credit_passport_one_active_per_user
    ON credit_passport.credentials (user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS credit_passport_credentials_user_idx
    ON credit_passport.credentials (user_id, version);

-- Consent-scoped, expiring disclosures. A partner may read the referenced
-- credential through the partner API only while a disclosure exists that
-- names the partner, carries the required scope, is unexpired and not
-- revoked. consent_recorded_at mirrors the NDPA consent record written to
-- identity consent storage in the same service action.
CREATE TABLE IF NOT EXISTS credit_passport.disclosures (
    id                  text PRIMARY KEY,           -- crpd-{uuid}
    credential_id       text NOT NULL
                        REFERENCES credit_passport.credentials(id),
    user_id             text NOT NULL REFERENCES identity.users(id),
    disclosed_to        text NOT NULL,              -- partner client / organisation id
    scope               text NOT NULL,              -- e.g. credit-passport:read
    consent_recorded_at timestamptz NOT NULL,
    expires_at          timestamptz NOT NULL,
    revoked_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > consent_recorded_at)
);
CREATE INDEX IF NOT EXISTS credit_passport_disclosures_credential_idx
    ON credit_passport.disclosures (credential_id);
CREATE INDEX IF NOT EXISTS credit_passport_disclosures_partner_idx
    ON credit_passport.disclosures (disclosed_to, user_id);

COMMIT;
