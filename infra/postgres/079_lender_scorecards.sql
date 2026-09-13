-- 079_lender_scorecards.sql — Stage 27, innovation #20 "Lender Lens":
-- standardized, versioned lender portfolio scorecards served over the
-- Partner API (spec pins 072; renumbered — 053..078 are taken by in-flight
-- waves).
--
-- Three tables in the analytics schema:
--
--   analytics.lender_scorecard_versions
--     Versioned scorecard DEFINITIONS (par windows, vintage cohort rule,
--     geo banding, staleness threshold, k-anonymity floor). A published
--     version is immutable: re-publishing the same version with a different
--     definition is rejected by the service layer (guarded INSERT), so an
--     old-version payload stays reproducible from the stored definition.
--
--   analytics.lender_scorecards
--     One immutable scorecard payload per (lender_partner_id, version,
--     period). payload is ALL-AGGREGATE (PAR vintages, geo mix bands,
--     product mix) — zero farmer PII; the natural-key UNIQUE constraint plus
--     the service-layer hash check make a generated scorecard immutable
--     (regeneration with an identical payload_hash is an idempotent no-op;
--     a divergent payload for the same key is a 409, never an overwrite).
--     payload_hash is the lower-case hex SHA-256 over the canonical JSON of
--     payload (sorted keys, no whitespace).
--
--   analytics.portfolio_benchmarks
--     Anonymized cross-lender benchmark cells per (version, period, metric).
--     k-anonymity floor (same doctrine as Chapter Map, innovation #10): a
--     cell is only published when at least 5 distinct lenders contribute;
--     below the floor the row is stored with suppressed = true and
--     value_bps = NULL so consumers can distinguish "suppressed" from
--     "missing".
--
-- Idempotent per repo policy (IF NOT EXISTS). No triggers, per repo
-- convention.

BEGIN;

CREATE TABLE IF NOT EXISTS analytics.lender_scorecard_versions (
    version         text PRIMARY KEY,           -- e.g. '1.0.0'
    definition      jsonb NOT NULL,             -- par windows, cohort rule, geo floor, thresholds
    published_at    timestamptz NOT NULL DEFAULT now(),
    published_by    text                        -- admin user id (audit trail, not PII)
);

CREATE TABLE IF NOT EXISTS analytics.lender_scorecards (
    id                  text PRIMARY KEY,
    lender_partner_id   text NOT NULL,          -- partner organisation slug (tenant), never a farmer id
    version             text NOT NULL REFERENCES analytics.lender_scorecard_versions (version),
    period              text NOT NULL,          -- Lagos calendar month 'YYYY-MM'
    payload             jsonb NOT NULL,         -- aggregate scorecard body; zero farmer PII
    payload_hash        text NOT NULL,          -- sha256 hex over canonical JSON of payload
    generated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT lender_scorecards_natural_key UNIQUE (lender_partner_id, version, period),
    CONSTRAINT lender_scorecards_period_format
        CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT lender_scorecards_payload_hash_format
        CHECK (payload_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS lender_scorecards_period_idx
    ON analytics.lender_scorecards (version, period);

CREATE TABLE IF NOT EXISTS analytics.portfolio_benchmarks (
    version         text NOT NULL REFERENCES analytics.lender_scorecard_versions (version),
    period          text NOT NULL,
    metric          text NOT NULL,              -- par30_bps | par60_bps | par90_bps
    band            text NOT NULL DEFAULT 'all',
    lender_count    integer NOT NULL CHECK (lender_count >= 0),
    value_bps       integer,                    -- NULL when suppressed (k-anonymity floor)
    suppressed      boolean NOT NULL,
    generated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (version, period, metric, band)
);

COMMIT;
