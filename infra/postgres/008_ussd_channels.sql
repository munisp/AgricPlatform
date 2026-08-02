-- 008_ussd_channels.sql — wave P5b lightweight-channel depth.
-- USSD (Africa's Talking) session state plus shared-device PIN profiles.
-- All statements are idempotent (IF NOT EXISTS) so the migration is safe
-- to re-apply. 007 is reserved for another wave.

BEGIN;

CREATE SCHEMA IF NOT EXISTS channels;

-- USSD session state machine rows. Africa's Talking identifies a session by
-- its sessionId; the full menu-engine state rides in `state` (jsonb) so the
-- engine stays a pure function over (state, input, data). expires_at is the
-- 3-minute inactivity deadline swept by UssdService.sweepExpiredSessions.
CREATE TABLE IF NOT EXISTS channels.ussd_sessions (
    session_id   text PRIMARY KEY,
    phone        text NOT NULL,
    msisdn       text NOT NULL,
    state        jsonb NOT NULL DEFAULT '{}'::jsonb,
    current_menu text NOT NULL DEFAULT 'main',
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ussd_sessions_expiry_idx
    ON channels.ussd_sessions (expires_at);

-- Shared-device PIN profiles (wave P5b): up to 5 family members per Android
-- device token, each unlocking a fast session swap with a 4-digit PIN.
-- PINs are stored salted-hashed only; attempts/locked_until implement the
-- 5-attempts / 15-minute lockout policy reused from the OTP flow.
CREATE TABLE IF NOT EXISTS channels.pin_profiles (
    device_token text NOT NULL,
    user_id      text NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
    pin_hash     text NOT NULL,
    attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    locked_until timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (device_token, user_id)
);

COMMIT;
