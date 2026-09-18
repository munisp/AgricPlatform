-- 116_farms_planting_lifecycle.sql — W2-FP4 planting lifecycle (dim04
-- A2/A3 + the V-03 event contract input):
--
--   * replant_of_id (A2): a replanted planting links to its FAILED
--     predecessor on the same plot, so failure → replant history is
--     traceable. Self-FK, nullable; ON DELETE SET NULL so deleting a
--     predecessor (plot cascade) never blocks deletion of the replant.
--   * failure_reason (V-03 contract): why the planting failed; stamped by
--     the service on the → failed transition and carried by the
--     farms.planting.status_changed event payload.
--   * status CHECK gains 'partially_harvested' (A3): a planting with picks
--     recorded and more expected is no longer terminally 'harvested' after
--     pick #1. The constraint is replaced via the re-apply-safe 016
--     DROP+ADD pattern.
--
-- Idempotent per migration policy: safe to re-run.

BEGIN;

ALTER TABLE farms.crop_plantings
    ADD COLUMN IF NOT EXISTS replant_of_id text REFERENCES farms.crop_plantings(id) ON DELETE SET NULL;

ALTER TABLE farms.crop_plantings
    ADD COLUMN IF NOT EXISTS failure_reason text
    CHECK (failure_reason IN ('drought','flood','pests','disease','input_failure','other'));

CREATE INDEX IF NOT EXISTS crop_plantings_replant_of_idx
    ON farms.crop_plantings (replant_of_id);

ALTER TABLE farms.crop_plantings
    DROP CONSTRAINT IF EXISTS crop_plantings_status_check;

ALTER TABLE farms.crop_plantings
    ADD CONSTRAINT crop_plantings_status_check
    CHECK (status IN ('growing','partially_harvested','harvested','failed'));

COMMIT;
