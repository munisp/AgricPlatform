-- 067_escrow_delivery_geo.sql — Stage 27, Innovation 9: Geo-Sealed Delivery
-- (location-verified escrow release).
--
-- An escrow on a produce order may OPT IN to a geo-sealed delivery leg: the
-- buyer pins an agreed drop point (stored as a res-9 H3 cell, computed
-- server-side — never client-supplied), and a buyer/agent device signs a
-- geo-attestation at delivery. The server recomputes H3 containment from the
-- signed coordinates; an in-geofence attestation moves the escrow
-- held → delivered_pending_confirm, and the existing expiry machinery
-- (confirm-window sweep) auto-releases it once the window elapses. An
-- out-of-geofence attestation is RECORDED (evidence) but rejected with
-- 409 GEO_FENCE_MISMATCH and never advances the state.
--
--   marketplace.delivery_attestations  append-only, hash-chained per escrow
--                                      (same scheme as livestock-passport
--                                      passport_events: seq + prev_hash +
--                                      payload_hash, genesis = 64 zeroes);
--                                      no UPDATE/DELETE path exists in the
--                                      repository, so history is
--                                      tamper-evident WITHOUT triggers.
--   marketplace.escrow_records         gains delivery_point_h3,
--                                      geofence_radius_cells (CHECK 0..10,
--                                      mirroring H3Service.MAX_GEO_RING) and
--                                      delivery_confirm_until (the confirm
--                                      window deadline; NULL = manual-basis
--                                      attestation, buyer confirm required —
--                                      the sweep never auto-releases it), and
--                                      admits the 'delivered_pending_confirm'
--                                      status.
--
-- Coordination notes: migration number 067 is reserved for this innovation
-- (061 is reserved for WP-G12). This migration does NOT alter the existing
-- escrow expiry semantics (016 held_until auto-refund); the confirm-window
-- auto-release is a distinct transition over the new delivery_confirm_until
-- column.
--
-- Idempotent per repo policy (IF NOT EXISTS / DROP+ADD / pg_constraint DO
-- block). No triggers, per repo convention.

BEGIN;

ALTER TABLE marketplace.escrow_records
    ADD COLUMN IF NOT EXISTS delivery_point_h3 text,
    ADD COLUMN IF NOT EXISTS geofence_radius_cells integer,
    ADD COLUMN IF NOT EXISTS delivery_confirm_until timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'escrow_records_geofence_radius_check'
    ) THEN
        ALTER TABLE marketplace.escrow_records
            ADD CONSTRAINT escrow_records_geofence_radius_check
            CHECK (geofence_radius_cells IS NULL OR geofence_radius_cells BETWEEN 0 AND 10);
    END IF;
END $$;

-- Admit the new geo-sealed state (re-apply-safe DROP+ADD, 016 pattern).
ALTER TABLE marketplace.escrow_records
    DROP CONSTRAINT IF EXISTS escrow_records_status_check;
ALTER TABLE marketplace.escrow_records
    ADD CONSTRAINT escrow_records_status_check
    CHECK (status IN ('held','releasing','released','refunding','refunded','disputed','delivered_pending_confirm'));

CREATE INDEX IF NOT EXISTS escrow_records_confirm_expiry_idx
    ON marketplace.escrow_records (delivery_confirm_until)
    WHERE status = 'delivered_pending_confirm';

CREATE TABLE IF NOT EXISTS marketplace.delivery_attestations (
    id               text PRIMARY KEY,        -- dlat-{uuid}
    escrow_id        text NOT NULL
                     REFERENCES marketplace.escrow_records(id),
    order_id         text NOT NULL
                     REFERENCES marketplace.orders(id),
    seq              integer NOT NULL CHECK (seq >= 0),
    attested_by      text NOT NULL,
    role             text NOT NULL CHECK (role IN ('buyer','agent')),
    lat              double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lng              double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
    h3_res9          text NOT NULL,           -- server-computed attestation cell
    within_geofence  boolean NOT NULL,        -- server-computed, never client-trusted
    device_basis     text NOT NULL CHECK (device_basis IN ('gps','network','manual')),
    attested_at      timestamptz NOT NULL DEFAULT now(),
    prev_hash        text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
    payload_hash     text NOT NULL UNIQUE CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (escrow_id, seq)
);
CREATE INDEX IF NOT EXISTS delivery_attestations_escrow_idx
    ON marketplace.delivery_attestations (escrow_id, seq);
CREATE INDEX IF NOT EXISTS delivery_attestations_order_idx
    ON marketplace.delivery_attestations (order_id);

-- Rollout flag row, default OFF (admins enable via the feature-flags API;
-- FeatureFlagsService is fail-closed for unknown/disabled flags).
INSERT INTO platform.feature_flags (key, enabled, role_allowlist, percentage, description)
VALUES (
    'geo-sealed-delivery',
    false,
    '{}',
    0,
    'Stage 27 Innovation 9: location-verified escrow release via server-side H3 containment'
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
