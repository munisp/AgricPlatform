-- ---------------------------------------------------------------------------
-- Wave LIVESTOCK-PASSPORT (Innovation #9): digital livestock passport.
-- One passport per registered animal (livestock.animals, wave L1a). The
-- passport itself is a thin identity anchor — health records, movements,
-- permits, liens and insurance policies stay in the livestock / livestock-
-- health / livestock-trade schemas (migrations 012/013/014) and are
-- AGGREGATED at read time; this schema only stores the passport record, the
-- append-only hash-chained passport event log (mirrors the traceability
-- custody chain, migrations 029/030 — no triggers) and the two-party
-- ownership-transfer workflow rows.
-- Idempotent: CREATE … IF NOT EXISTS throughout; safe to re-apply.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE SCHEMA IF NOT EXISTS livestock_passport;

-- Passport anchor. passport_code is the public, HMAC-signed verification
-- code (agentbank voucher pattern): payload (passport id + animal id +
-- nonce) signed with LIVESTOCK_PASSPORT_SECRET, so forged codes fail
-- verification server-side. The raw HMAC signature is stored alongside for
-- constant-time re-verification.
CREATE TABLE IF NOT EXISTS livestock_passport.passports (
    id                  text PRIMARY KEY,           -- lsp-{uuid}
    animal_id           text NOT NULL UNIQUE
                        REFERENCES livestock.animals(animal_id),
    passport_code       text NOT NULL UNIQUE,       -- LSP-{animal}.{nonce}.{sig16}
    code_nonce          text NOT NULL,
    code_signature      text NOT NULL,              -- HMAC-SHA256 hex (64)
    owner_user_id       text NOT NULL REFERENCES identity.users(id),
    status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','suspended','revoked')),
    -- External animal-ID authority / RFID registry check at issue time.
    -- Honest basis label: 'stub' (deterministic simulated driver, default),
    -- 'live' (configured authority answered), 'unavailable' (live driver
    -- configured but unreachable) or 'none' (no tag/eid to check).
    tag_check_basis     text NOT NULL DEFAULT 'none'
                        CHECK (tag_check_basis IN ('stub','live','unavailable','none')),
    tag_check_detail    text,
    issued_by           text NOT NULL REFERENCES identity.users(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lsp_passports_owner_idx
    ON livestock_passport.passports (owner_user_id, status);

-- Append-only passport event log. seq + prev_event_hash + event_hash form a
-- per-passport sha256 chain (canonical-JSON payload, genesis = 64 zeroes);
-- no update/delete path exists in the pg repository, so history is
-- tamper-evident WITHOUT database triggers (lint:sql constraint).
CREATE TABLE IF NOT EXISTS livestock_passport.passport_events (
    id                  text PRIMARY KEY,           -- lspe-{uuid}
    passport_id         text NOT NULL
                        REFERENCES livestock_passport.passports(id),
    seq                 integer NOT NULL CHECK (seq >= 0),
    type                text NOT NULL
                        CHECK (type IN ('ISSUED','TRANSFER_INITIATED',
                                        'TRANSFER_CONFIRMED','TRANSFER_CANCELLED',
                                        'SUSPENDED','REINSTATED','REVOKED')),
    actor_id            text NOT NULL,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
    prev_event_hash     text NOT NULL,
    event_hash          text NOT NULL UNIQUE,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (passport_id, seq)
);
CREATE INDEX IF NOT EXISTS lsp_events_passport_idx
    ON livestock_passport.passport_events (passport_id, seq);

-- Two-party ownership transfer workflow (seller initiates, buyer confirms).
-- The executed transfer itself is written through the existing livestock
-- core path (livestock.ownership_transfers + animals.owner_user_id via
-- AnimalRepository.transferOwnership) so there is a single ownership
-- ledger; this table tracks the pending/confirmed handshake and the
-- both-party audit trail. At most one pending transfer per passport
-- (partial unique index below).
CREATE TABLE IF NOT EXISTS livestock_passport.passport_transfers (
    id                  text PRIMARY KEY,           -- lspt-{uuid}
    passport_id         text NOT NULL
                        REFERENCES livestock_passport.passports(id),
    animal_id           text NOT NULL
                        REFERENCES livestock.animals(animal_id),
    from_user_id        text NOT NULL REFERENCES identity.users(id),
    to_user_id          text NOT NULL REFERENCES identity.users(id),
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','confirmed','cancelled')),
    note                text,
    -- livestock.ownership_transfers row written at confirmation.
    executed_transfer_id text,
    initiated_at        timestamptz NOT NULL DEFAULT now(),
    confirmed_at        timestamptz,
    cancelled_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lsp_transfers_one_pending_idx
    ON livestock_passport.passport_transfers (passport_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS lsp_transfers_buyer_idx
    ON livestock_passport.passport_transfers (to_user_id, status);
CREATE INDEX IF NOT EXISTS lsp_transfers_seller_idx
    ON livestock_passport.passport_transfers (from_user_id, status);

COMMIT;
