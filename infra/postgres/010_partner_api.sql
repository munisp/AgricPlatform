-- 010_partner_api.sql — wave P5d partner API storage.
-- Partner OAuth clients (machine-to-machine), developer API keys and
-- outbound webhook subscriptions. All secret material is stored hashed
-- (sha256 + per-row salt); plaintext secrets are shown exactly once at
-- issuance. All statements are idempotent (IF NOT EXISTS) so the
-- migration is safe to re-apply. 007/008/009 are reserved for other waves.

BEGIN;

CREATE SCHEMA IF NOT EXISTS partners;

-- M2M clients for the client-credentials grant (POST /api/v1/partner/oauth/token).
CREATE TABLE IF NOT EXISTS partners.partner_clients (
    id                  text PRIMARY KEY,
    name                text NOT NULL,
    client_id           text NOT NULL UNIQUE,
    client_secret_hash  text NOT NULL,          -- sha256(salt + secret)
    client_secret_salt  text NOT NULL,
    scopes              text[] NOT NULL DEFAULT '{}',
    status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    rate_limit_per_min  integer NOT NULL DEFAULT 1000 CHECK (rate_limit_per_min > 0),
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- Developer API keys (shown once; only the hash + display prefix persist).
CREATE TABLE IF NOT EXISTS partners.api_keys (
    id              text PRIMARY KEY,
    owner_user_id   text NOT NULL,
    key_hash        text NOT NULL,              -- sha256(salt + key)
    key_salt        text NOT NULL,
    prefix          text NOT NULL,              -- first 8 chars for support lookups
    scopes          text[] NOT NULL DEFAULT '{}',
    sandbox         boolean NOT NULL DEFAULT true,
    revoked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_keys_owner_idx ON partners.api_keys (owner_user_id);

-- Outbound webhook subscriptions, HMAC-signed per subscription secret.
CREATE TABLE IF NOT EXISTS partners.webhook_subscriptions (
    id           text PRIMARY KEY,
    client_id    text NOT NULL REFERENCES partners.partner_clients (client_id) ON DELETE CASCADE,
    event_types  text[] NOT NULL DEFAULT '{}',
    target_url   text NOT NULL,
    secret       text NOT NULL,                 -- HMAC signing secret (delivery-time only)
    status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_subscriptions_client_idx
    ON partners.webhook_subscriptions (client_id);

COMMIT;
