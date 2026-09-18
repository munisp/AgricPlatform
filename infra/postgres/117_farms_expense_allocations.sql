-- 117_farms_expense_allocations.sql — W2-FP4 intercrop expense allocation
-- (dim04 A4). An expense on an intercropped plot may carry EXPLICIT
-- per-planting shares; without rows here the expense is PLOT-LEVEL (the
-- documented default rule: shared across the plot, never silently
-- full-attributed to one crop).
--
-- One row per (expense, planting) share; share_percent is a percentage of
-- the expense's amount_kobo. The service enforces sum = 100 when
-- allocations are supplied (application-level rule — a CHECK cannot sum
-- across rows); the DB enforces range + uniqueness + referential integrity.
--
-- Idempotent per migration policy: safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS farms.expense_allocations (
    expense_id    text NOT NULL REFERENCES farms.farm_expenses(id) ON DELETE CASCADE,
    planting_id   text NOT NULL REFERENCES farms.crop_plantings(id) ON DELETE CASCADE,
    share_percent double precision NOT NULL
                  CHECK (share_percent > 0 AND share_percent <= 100),
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (expense_id, planting_id)
);

CREATE INDEX IF NOT EXISTS expense_allocations_planting_idx
    ON farms.expense_allocations (planting_id);

COMMIT;
