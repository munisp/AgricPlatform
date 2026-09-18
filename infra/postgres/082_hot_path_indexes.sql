-- no-transaction
-- V-75 (dim06-M1): indexes on hot FK/lookup columns that currently seq-scan.
--
-- This file carries the `-- no-transaction` first-line marker (see
-- apps/api/src/database/migrate.ts): CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block, so the runner applies each statement
-- individually without an enclosing BEGIN/COMMIT. Consequences:
--   * every statement is idempotent (IF NOT EXISTS) so a failed run can be
--     re-driven safely;
--   * a crashed CONCURRENTLY build can leave an INVALID index behind —
--     DROP INDEX IF EXISTS + re-run per docs/runbooks/ops.md (migrations).
--
-- Run during a low-traffic window: CONCURRENTLY avoids write-blocking
-- locks but still performs a full table scan per index.

-- marketplace.order_events.order_id — every order-history read and every
-- order delete (ON DELETE CASCADE) seq-scans the append-only event log.
CREATE INDEX CONCURRENTLY IF NOT EXISTS order_events_order_id_idx
    ON marketplace.order_events (order_id);

-- marketplace.orders.listing_id — "orders for listing" and FK-delete
-- checks seq-scan orders (only buyer/seller indexes existed).
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_listing_id_idx
    ON marketplace.orders (listing_id);

-- livestock.lot_animals.animal_id — the PK (lot_id, animal_id) covers
-- lot→animals; the reverse animal→lots lookup was unindexed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS lot_animals_animal_id_idx
    ON livestock.lot_animals (animal_id);
