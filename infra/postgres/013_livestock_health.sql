-- 013_livestock_health.sql — wave L1b Africa Livestock Trust Platform (ALTP).
-- Vet-signed animal-health ledger, chain-of-custody movement log, state
-- movement permits, recalls and disease surveillance flags. Reuses the
-- livestock schema from 012. All statements are idempotent (IF NOT EXISTS)
-- so the migration is safe to re-apply.

BEGIN;

CREATE SCHEMA IF NOT EXISTS livestock;

-- Vet-signed health ledger (blueprint F2/F3.4). Append-only: corrections are
-- reversing entries (reversal_of_id points at the annulled record); the
-- application never UPDATEs or DELETEs rows. `signature` is an HMAC-SHA256
-- (base64url) over the canonical payload (version, animal, record type,
-- product, batch, dose, administered_at, vet_user_id, signed_at).
CREATE TABLE IF NOT EXISTS livestock.health_records (
    id              text PRIMARY KEY,
    animal_id       text NOT NULL REFERENCES livestock.animals(animal_id),
    record_type     text NOT NULL CHECK (record_type IN ('vaccination','treatment')),
    product         text NOT NULL,
    batch_number    text NOT NULL,
    dose            text NOT NULL,
    administered_at timestamptz NOT NULL,
    withdrawal_until timestamptz,
    vet_user_id     text NOT NULL REFERENCES identity.users(id),
    notes           text,
    signature       text NOT NULL,
    signed_at       timestamptz NOT NULL,
    reversal_of_id  text REFERENCES livestock.health_records(id),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS health_records_animal_idx
    ON livestock.health_records (animal_id);
CREATE INDEX IF NOT EXISTS health_records_batch_idx
    ON livestock.health_records (batch_number);
CREATE INDEX IF NOT EXISTS health_records_vet_idx
    ON livestock.health_records (vet_user_id);

-- State movement permits (blueprint F4.3). Issued by a vet/regulator;
-- revocation keeps the row with a reason (audit trail).
CREATE TABLE IF NOT EXISTS livestock.movement_permits (
    id              text PRIMARY KEY,
    permit_number   text NOT NULL,
    from_state      text NOT NULL,
    to_state        text NOT NULL,
    valid_from      timestamptz NOT NULL,
    valid_until     timestamptz NOT NULL,
    status          text NOT NULL DEFAULT 'issued'
                    CHECK (status IN ('issued','revoked')),
    issued_by       text NOT NULL REFERENCES identity.users(id),
    revoked_reason  text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS movement_permits_number_key
    ON livestock.movement_permits (permit_number);

-- Permit subjects: the animals and/or lots a permit covers.
CREATE TABLE IF NOT EXISTS livestock.movement_permit_subjects (
    permit_id       text NOT NULL REFERENCES livestock.movement_permits(id) ON DELETE CASCADE,
    subject_type    text NOT NULL CHECK (subject_type IN ('animal','lot')),
    subject_id      text NOT NULL,
    PRIMARY KEY (permit_id, subject_type, subject_id)
);

-- Chain-of-custody movement log (blueprint F4.1). Exactly one of
-- animal_id/lot_id is set. A movement is open until arrived_at is recorded;
-- the application rejects a new movement while one is open.
CREATE TABLE IF NOT EXISTS livestock.movements (
    id              text PRIMARY KEY,
    animal_id       text REFERENCES livestock.animals(animal_id),
    lot_id          text REFERENCES livestock.lots(lot_id),
    from_state      text NOT NULL,
    from_lga        text,
    to_state        text NOT NULL,
    to_lga          text,
    departed_at     timestamptz NOT NULL,
    arrived_at      timestamptz,
    transport_mode  text NOT NULL
                    CHECK (transport_mode IN ('trek','truck','rail','boat','air')),
    purpose         text NOT NULL
                    CHECK (purpose IN ('sale','grazing','market','slaughter','breeding','quarantine','other')),
    permit_id       text REFERENCES livestock.movement_permits(id),
    recorded_by     text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK ((animal_id IS NOT NULL) OR (lot_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS movements_animal_idx
    ON livestock.movements (animal_id);
CREATE INDEX IF NOT EXISTS movements_lot_idx
    ON livestock.movements (lot_id);
CREATE INDEX IF NOT EXISTS movements_open_idx
    ON livestock.movements (animal_id) WHERE arrived_at IS NULL;

-- Recall cases (blueprint F4.2 — 24-hour traceback). Exactly one scope
-- (animal / lot / owner / region=state+date range); batch_number is an
-- optional product-batch filter matched against health records.
CREATE TABLE IF NOT EXISTS livestock.recalls (
    id              text PRIMARY KEY,
    scope           text NOT NULL CHECK (scope IN ('animal','lot','owner','region')),
    animal_id       text,
    lot_id          text,
    owner_user_id   text,
    state           text,
    from_date       timestamptz,
    to_date         timestamptz,
    batch_number    text,
    reason          text NOT NULL,
    status          text NOT NULL DEFAULT 'initiated'
                    CHECK (status IN ('initiated','notified','resolved')),
    initiated_by    text NOT NULL REFERENCES identity.users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    notified_at     timestamptz,
    resolved_at     timestamptz
);

CREATE INDEX IF NOT EXISTS recalls_status_idx
    ON livestock.recalls (status);
CREATE INDEX IF NOT EXISTS recalls_state_idx
    ON livestock.recalls (state);

-- Animals materialised into a recall at initiation (with the owner captured
-- for notification targeting), so the case stays auditable as lots and
-- ownership change afterwards.
CREATE TABLE IF NOT EXISTS livestock.recall_animals (
    recall_id       text NOT NULL REFERENCES livestock.recalls(id) ON DELETE CASCADE,
    animal_id       text NOT NULL REFERENCES livestock.animals(animal_id),
    owner_user_id   text NOT NULL,
    added_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (recall_id, animal_id)
);

-- Disease surveillance flags (blueprint F5.1/F5.4). Lifecycle
-- reported → confirmed / retracted; retraction always records the
-- false-positive reason.
CREATE TABLE IF NOT EXISTS livestock.disease_flags (
    id              text PRIMARY KEY,
    disease         text NOT NULL,
    state           text NOT NULL,
    lga             text,
    suspected_species text
                    CHECK (suspected_species IN ('cattle','sheep','goat','chicken','pig')),
    reporter_user_id text NOT NULL REFERENCES identity.users(id),
    status          text NOT NULL DEFAULT 'reported'
                    CHECK (status IN ('reported','confirmed','retracted')),
    confirmed_by    text,
    retracted_reason text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS disease_flags_state_status_idx
    ON livestock.disease_flags (state, status);

COMMIT;
