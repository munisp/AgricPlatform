-- 072_cooperative_score.sql — Innovation 14 (stage-27): Cooperative Score,
-- institution-level credit readiness (0-1000) for the cooperative itself
-- (cooperative = chapter; credit/vsla groups link via chapter_id).
--
-- credit.coop_scores is VERSIONED and APPEND-ONLY: every recompute appends a
-- new row with version = max(version)+1 per cooperative, so score history is
-- itself underwriting evidence. Recompute with unchanged inputs is a no-op —
-- the (cooperative_id, inputs_hash) unique index makes the append idempotent.
-- No UPDATE/DELETE paths exist in the application repository; per migration
-- policy there are no DB triggers.
--
-- Idempotent (IF NOT EXISTS throughout), no triggers, schema-per-domain.
-- Depends on migration 025 (credit schema) only.

BEGIN;

CREATE SCHEMA IF NOT EXISTS credit;

CREATE TABLE IF NOT EXISTS credit.coop_scores (
    id              text PRIMARY KEY,
    -- The cooperative: a chapters row id (chapters.chapters.id).
    cooperative_id  text NOT NULL,
    -- 1-based append-only version per cooperative (unique pair below).
    version         integer NOT NULL CHECK (version >= 1),
    score           integer NOT NULL CHECK (score BETWEEN 0 AND 1000),
    -- A/B/C/D underwriting band; transitions drive lender webhooks
    -- (credit.coop_score.band_changed).
    band            text NOT NULL CHECK (band IN ('A','B','C','D')),
    -- 5 named factors with weights, points and per-factor basis badges
    -- (measured | sparse | unavailable) — the explainability payload.
    factor_scores   jsonb NOT NULL,
    -- Canonical fingerprint of the assembled factor inputs; recompute with
    -- an identical hash appends NOTHING (idempotent batch recompute).
    inputs_hash     text NOT NULL,
    computed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS coop_scores_coop_version_uq
    ON credit.coop_scores (cooperative_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS coop_scores_coop_inputs_uq
    ON credit.coop_scores (cooperative_id, inputs_hash);
CREATE INDEX IF NOT EXISTS coop_scores_coop_idx
    ON credit.coop_scores (cooperative_id);
CREATE INDEX IF NOT EXISTS coop_scores_computed_idx
    ON credit.coop_scores (computed_at);

COMMIT;
