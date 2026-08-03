-- 028_geocredit.sql — geo-verified credit, SHADOW MODE (wave-geocredit).
-- The sixth credit-scoring factor (geospatial plot verification + crop
-- health) is computed deterministically and persisted ONLY here; the live
-- approve/decline path (migration 025 credit.loan_applications) never reads
-- this table. Plain idempotent SQL — no triggers, no PostGIS. Safe to
-- re-apply (IF NOT EXISTS throughout).

BEGIN;

-- One row per (application, input fingerprint): recomputation with unchanged
-- inputs is a no-op (idempotent batch recompute), changed inputs append a new
-- row so officers can see the shadow score evolve. factor_score is nullable
-- because a fail-closed 'unavailable' result (live crop-ml configured but
-- unreachable) records NO score rather than fabricating one.
CREATE TABLE IF NOT EXISTS credit.geo_credit_shadow_scores (
    id                text PRIMARY KEY,
    application_id    text NOT NULL,
    factor_score      integer
                      CHECK (factor_score IS NULL OR (factor_score >= 0 AND factor_score <= 100)),
    status            text NOT NULL
                      CHECK (status IN ('computed','unavailable')),
    breakdown         jsonb NOT NULL,
    basis             jsonb NOT NULL,
    input_fingerprint text NOT NULL,
    computed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS geo_credit_shadow_app_fp_uq
    ON credit.geo_credit_shadow_scores (application_id, input_fingerprint);
CREATE INDEX IF NOT EXISTS geo_credit_shadow_app_idx
    ON credit.geo_credit_shadow_scores (application_id);
CREATE INDEX IF NOT EXISTS geo_credit_shadow_computed_idx
    ON credit.geo_credit_shadow_scores (computed_at);

COMMIT;
