-- ---------------------------------------------------------------------------
-- Wave MECHANIZATION (Innovation #10): equipment hire marketplace.
-- Cooperative/individual owners list machinery with H3 service areas (no
-- PostGIS — cells computed in the app layer via the geo module's H3Service);
-- farmers request bookings, owners quote, farmers confirm with a ledger
-- payment HOLD (stub execution mode — the finance ledger is the system of
-- record; no real charges), and the hold is released per a deterministic
-- cancellation schedule (see docs/mechanization-marketplace.md).
-- Idempotent: CREATE … IF NOT EXISTS throughout; safe to re-apply.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE SCHEMA IF NOT EXISTS mechanization;

CREATE TABLE IF NOT EXISTS mechanization.equipment_listings (
    id                      text PRIMARY KEY,
    owner_user_id           text NOT NULL REFERENCES identity.users(id),
    owner_type              text NOT NULL
                            CHECK (owner_type IN ('cooperative','individual')),
    type                    text NOT NULL
                            CHECK (type IN ('tractor','planter','harvester','sprayer_drone','thresher')),
    title                   text NOT NULL,
    description             text NOT NULL DEFAULT '',
    specs                   jsonb NOT NULL DEFAULT '{}'::jsonb,
    base_lat                double precision NOT NULL
                            CHECK (base_lat BETWEEN -90 AND 90),
    base_long               double precision NOT NULL
                            CHECK (base_long BETWEEN -180 AND 180),
    service_area_h3         text[] NOT NULL DEFAULT '{}',
    service_area_resolution smallint NOT NULL
                            CHECK (service_area_resolution BETWEEN 5 AND 7),
    rates                   jsonb NOT NULL,      -- EquipmentRates (per_ha/per_hour/per_km/included_km)
    availability            jsonb NOT NULL DEFAULT '[]'::jsonb, -- AvailabilityWindow[]
    operator_license_ref    text,
    operator_verification   text NOT NULL DEFAULT 'pending'
                            CHECK (operator_verification IN ('pending','verified','suspended')),
    status                  text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','active','paused')),
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mech_listings_owner_idx
    ON mechanization.equipment_listings (owner_user_id, status);
CREATE INDEX IF NOT EXISTS mech_listings_type_idx
    ON mechanization.equipment_listings (type) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS mech_listings_area_gin
    ON mechanization.equipment_listings USING gin (service_area_h3);

CREATE TABLE IF NOT EXISTS mechanization.equipment_bookings (
    id                  text PRIMARY KEY,
    listing_id          text NOT NULL REFERENCES mechanization.equipment_listings(id),
    owner_user_id       text NOT NULL REFERENCES identity.users(id),
    farmer_id           text NOT NULL REFERENCES identity.users(id),
    plot_id             text,
    plot_lat            double precision NOT NULL
                        CHECK (plot_lat BETWEEN -90 AND 90),
    plot_long           double precision NOT NULL
                        CHECK (plot_long BETWEEN -180 AND 180),
    plot_h3             text NOT NULL,
    area_ha             numeric(10,2) NOT NULL CHECK (area_ha > 0),
    estimated_hours     numeric(10,2) CHECK (estimated_hours IS NULL OR estimated_hours > 0),
    window_start        timestamptz NOT NULL,
    window_end          timestamptz NOT NULL,
    status              text NOT NULL DEFAULT 'requested'
                        CHECK (status IN ('requested','quoted','confirmed','in_service',
                                          'completed','rated','cancelled','disputed')),
    quote               jsonb,                   -- MechQuoteBreakdown, set at quote time
    advisory            jsonb,                   -- MechAdvisory (advisory only, never blocks)
    hold_entry_id       text,                    -- finance ledger journal entry id (stub mode)
    farmer_confirmed_completion_at timestamptz,
    owner_confirmed_completion_at  timestamptz,
    rating              smallint CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
    review_comment      text,
    cancelled_by        text CHECK (cancelled_by IS NULL OR cancelled_by IN ('farmer','owner','admin')),
    cancel_reason       text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK (window_end > window_start)
);
-- Conflict detection scans non-terminal bookings per listing by window.
CREATE INDEX IF NOT EXISTS mech_bookings_listing_window_idx
    ON mechanization.equipment_bookings (listing_id, status, window_start, window_end);
CREATE INDEX IF NOT EXISTS mech_bookings_farmer_idx
    ON mechanization.equipment_bookings (farmer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mech_bookings_owner_idx
    ON mechanization.equipment_bookings (owner_user_id, status);

COMMIT;
