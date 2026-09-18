-- 089_erasure_holds.sql — W2-FP1 V-25 (erasure fan-out, dim05-10/M9).
--
-- NDPA inventory categories under legal hold keep data past an erasure
-- request ONLY with a per-category DPO sign-off recorded here — never
-- silently. One hold per (user, category).
--
-- Idempotent per migration policy. Additive only.

BEGIN;

CREATE TABLE IF NOT EXISTS privacy.erasure_holds (
    id            text PRIMARY KEY,
    user_id       text NOT NULL,
    category      text NOT NULL,
    reason        text NOT NULL,
    signed_off_by text NOT NULL,
    signed_off_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS erasure_holds_user_category_idx
    ON privacy.erasure_holds (user_id, category);

COMMIT;
