-- 126_farm_plot_accuracy.sql — GAP-L10: persist GPS fix quality on farm plots.
--
-- The mobile capture app collects the GPS accuracyMeters of the centroid fix
-- but had nowhere to send it; the column keeps that location-quality metadata
-- with the plot so geo evidence downstream (credit geo-verification, MRV)
-- can weigh captures by accuracy. Nullable: rows captured before this column
-- existed simply have no recorded accuracy.
--
-- Idempotent (IF NOT EXISTS) per migration policy.

BEGIN;

ALTER TABLE farms.farm_plots
    ADD COLUMN IF NOT EXISTS accuracy_meters double precision
        CHECK (accuracy_meters >= 0);

COMMIT;
