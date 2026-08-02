-- 007_phase3_integrations.sql — wave P5a federated integration / ACL storage.
-- Supports the Phase-3 federated systems (docs/integration-matrix.md):
-- farmOS/LiteFarm farm-record sync, OFN syndication, ODK/Kobo beneficiary
-- import, lender input-finance bridge and inbound webhooks. All statements
-- are idempotent (IF NOT EXISTS) so the migration is safe to re-apply.
-- 003–006 and 008+ are reserved for other waves.

BEGIN;

CREATE SCHEMA IF NOT EXISTS integrations;

-- Explicit farmer link to an external system account (farmOS, LiteFarm).
-- consent_at records when the farmer granted sharing consent; revoked_at is
-- set on unlink (soft revoke keeps the audit trail).
CREATE TABLE IF NOT EXISTS integrations.external_account_links (
    id           text PRIMARY KEY,
    user_id      text NOT NULL REFERENCES identity.users(id),
    system       text NOT NULL,              -- farmos|litefarm
    external_id  text NOT NULL,              -- account id on the remote system
    consent_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, system, external_id)
);

CREATE INDEX IF NOT EXISTS external_account_links_user_idx
    ON integrations.external_account_links (user_id);

-- Normalised farm records (crop plans, harvest records, field maps) pulled
-- via the ACL adapter. payload keeps the source document; the UNIQUE key
-- makes re-syncs replay-safe.
CREATE TABLE IF NOT EXISTS integrations.farm_records (
    id           text PRIMARY KEY,
    link_id      text NOT NULL REFERENCES integrations.external_account_links(id),
    record_type  text NOT NULL,              -- crop_plan|harvest|field_map
    external_id  text NOT NULL,              -- record id on the remote system
    payload      jsonb NOT NULL,
    source       text NOT NULL,              -- farmos|litefarm
    observed_at  timestamptz NOT NULL,
    synced_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (link_id, record_type, external_id)
);

CREATE INDEX IF NOT EXISTS farm_records_link_idx
    ON integrations.farm_records (link_id, record_type);

-- NGO/donor beneficiary import (ODK/Kobo): a batch groups one upload or
-- pull; records stay STAGED until an admin confirms the merge.
CREATE TABLE IF NOT EXISTS integrations.import_batches (
    id           text PRIMARY KEY,
    source_system text NOT NULL,             -- odk|kobo|csv_upload
    donor_source text NOT NULL,              -- donor / NGO programme label
    status       text NOT NULL DEFAULT 'STAGED' CHECK (status IN ('STAGED','CONFIRMED')),
    record_count integer NOT NULL DEFAULT 0 CHECK (record_count >= 0),
    created_by   text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    confirmed_at timestamptz,
    confirmed_by text
);

-- Imported beneficiary rows. Identity fields are stored only as SHA-256
-- hashes (NDPR minimisation); the raw row lives in payload for the admin
-- review window. status STAGED → MERGED|REJECTED on confirm.
CREATE TABLE IF NOT EXISTS integrations.import_records (
    id           text PRIMARY KEY,
    batch_id     text NOT NULL REFERENCES integrations.import_batches(id),
    nin_hash     text,
    phone_hash   text,
    payload      jsonb NOT NULL,
    status       text NOT NULL DEFAULT 'STAGED' CHECK (status IN ('STAGED','MERGED','REJECTED')),
    donor_source text NOT NULL,
    consent_date timestamptz NOT NULL,       -- donor-attested consent capture date
    matched_user_id text REFERENCES identity.users(id),
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_records_batch_idx
    ON integrations.import_records (batch_id, status);

-- Generic inbound webhook/event ledger for the federated systems (farmOS
-- push, OFN order events, lender loan events). dedupe_key is supplied by
-- the receiver (provider event id or a payload hash) so replays are
-- idempotent.
CREATE TABLE IF NOT EXISTS integrations.inbound_events (
    id           text PRIMARY KEY,
    system       text NOT NULL,              -- farmos|litefarm|ofn|lender
    event_type   text NOT NULL,
    dedupe_key   text NOT NULL,
    payload      jsonb NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    UNIQUE (system, dedupe_key)
);

CREATE INDEX IF NOT EXISTS inbound_events_system_idx
    ON integrations.inbound_events (system, event_type, received_at DESC);

COMMIT;
