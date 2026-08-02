-- 012_livestock.sql — wave L1a Africa Livestock Trust Platform (ALTP) core.
-- Animal identity registry (national ID NG-{SPECIES}-{STATE}-{serial}),
-- group lots, ownership transfer ledger and pastoralist profiles.
-- All statements are idempotent (IF NOT EXISTS) so the migration is safe
-- to re-apply.

BEGIN;

CREATE SCHEMA IF NOT EXISTS livestock;

-- Individual animal identity. animal_id embeds species/state/serial and is
-- issued atomically from livestock.animal_serials. tag_id (visual ear tag)
-- is unique when present; eid is the optional electronic (RFID) identifier.
-- sire_id/dam_id are nullable self-references for pedigree tracking.
CREATE TABLE IF NOT EXISTS livestock.animals (
    animal_id       text PRIMARY KEY,        -- NG-{SPECIES}-{STATE}-{6-digit serial}
    species         text NOT NULL
                    CHECK (species IN ('cattle','sheep','goat','chicken','pig')),
    breed           text NOT NULL,
    sex             text NOT NULL CHECK (sex IN ('male','female')),
    birth_date      date,
    tag_id          text,
    eid             text,
    owner_user_id   text NOT NULL REFERENCES identity.users(id),
    state           text NOT NULL,
    lga             text,
    status          text NOT NULL DEFAULT 'alive'
                    CHECK (status IN ('alive','sold','dead','stolen')),
    sire_id         text REFERENCES livestock.animals(animal_id),
    dam_id          text REFERENCES livestock.animals(animal_id),
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS animals_owner_idx
    ON livestock.animals (owner_user_id);
CREATE INDEX IF NOT EXISTS animals_species_state_idx
    ON livestock.animals (species, state);
CREATE UNIQUE INDEX IF NOT EXISTS animals_tag_id_key
    ON livestock.animals (tag_id);

-- Atomic serial issuance per (species, state). The pg repository increments
-- with INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING; lot IDs reuse the
-- same counter table with a 'lot:' species prefix.
CREATE TABLE IF NOT EXISTS livestock.animal_serials (
    species         text NOT NULL,
    state           text NOT NULL,
    next_serial     integer NOT NULL DEFAULT 1,
    PRIMARY KEY (species, state)
);

-- Group lots (flocks/pens/herds managed as a unit).
CREATE TABLE IF NOT EXISTS livestock.lots (
    lot_id          text PRIMARY KEY,        -- LOT-{SPECIES}-{STATE}-{6-digit serial}
    species         text NOT NULL
                    CHECK (species IN ('cattle','sheep','goat','chicken','pig')),
    quantity        integer NOT NULL CHECK (quantity >= 0),
    owner_user_id   text NOT NULL REFERENCES identity.users(id),
    state           text NOT NULL,
    lga             text,
    formation_rule  text,
    status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','closed','sold')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lots_owner_idx
    ON livestock.lots (owner_user_id);

-- Lot membership (which registered animals belong to which lot).
CREATE TABLE IF NOT EXISTS livestock.lot_animals (
    lot_id          text NOT NULL REFERENCES livestock.lots(lot_id) ON DELETE CASCADE,
    animal_id       text NOT NULL REFERENCES livestock.animals(animal_id),
    added_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (lot_id, animal_id)
);

-- Ownership transfer ledger (append-only; animals.owner_user_id is updated
-- in the same transaction as the ledger insert).
CREATE TABLE IF NOT EXISTS livestock.ownership_transfers (
    id              text PRIMARY KEY,
    animal_id       text NOT NULL REFERENCES livestock.animals(animal_id),
    from_user_id    text NOT NULL REFERENCES identity.users(id),
    to_user_id      text NOT NULL REFERENCES identity.users(id),
    transfer_type   text NOT NULL
                    CHECK (transfer_type IN ('sale','gift','programme','aggregation')),
    effective_at    timestamptz NOT NULL,
    recorded_by     text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ownership_transfers_animal_idx
    ON livestock.ownership_transfers (animal_id);

-- Pastoralist profile extension (grazing/migration metadata), keyed by user.
CREATE TABLE IF NOT EXISTS livestock.pastoralist_profiles (
    user_id         text PRIMARY KEY REFERENCES identity.users(id) ON DELETE CASCADE,
    grazing_zone_id text,
    migration_pattern text,
    primary_species text[] NOT NULL DEFAULT '{}',
    updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMIT;
