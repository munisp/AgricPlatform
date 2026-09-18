-- 081_fp3_money_path_uniqueness.sql — FP-3 audit fixes V-21 + V-52:
-- database backstops for two money-path uniqueness invariants that were
-- previously enforced only by service-level check-then-act (racy on BOTH
-- drivers).
--
--   1. V-21: one open warehouse deposit per commodity lot. The service check
--      (WarehouseService.createDeposit) could be passed by two concurrent
--      deposits for the same lot, double-receipting the same physical bag.
--      This partial UNIQUE index makes the second INSERT fail with 23505
--      (→ 409 via mapPgError). Withdrawn deposits are excluded so a lot can
--      be re-deposited after withdrawal.
--
--   2. V-52: one non-cancelled invoice per order. Two concurrent
--      POST /orders/:id/invoice calls produced two collectible documents for
--      one order. Cancelled invoices are excluded so re-issue after
--      cancellation stays possible.
--
-- NOTE (online-migration conflict, owned by FP-5/V-75+V-76): these are plain
-- CREATE UNIQUE INDEX statements inside the runner's implicit transaction.
-- CONCURRENTLY cannot be used here because migrate.ts applies each file as a
-- single multi-statement query (one implicit transaction), and CREATE INDEX
-- CONCURRENTLY is illegal inside a transaction block. The deposits/invoices
-- tables are small enough today for a blocking build; converting the runner
-- to support non-transactional files with CONCURRENTLY is FP-5 scope.
--
-- Idempotent per repo policy (IF NOT EXISTS). No triggers, per repo convention.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS warehouse_deposits_open_lot_uq
    ON warehouse.deposits (lot_id)
    WHERE status <> 'withdrawn' AND lot_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_open_order_uq
    ON marketplace.invoices (order_id)
    WHERE status <> 'cancelled';

COMMIT;
