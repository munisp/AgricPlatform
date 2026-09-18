-- 106_order_partial_fulfilment.sql — V-36: partial delivery + shipment
-- failure fast-track for marketplace orders (Wave-2 pack W2-C3).
--
-- Orders were atomic: a delivery was all-or-nothing and a failed shipment
-- unwound only via the 14-day escrow expiry. The order row now carries the
-- actually-delivered quantity when it is less than the ordered quantity; on
-- completion the escrow settles by split (V-06 machinery): the delivered
-- share releases to the seller and the remainder refunds to the buyer.
--
--   marketplace.orders  gains delivered_quantity (NULL = full/unspecified;
--                       CHECK 1..quantity-1 — a value >= quantity is just a
--                       full delivery and must stay NULL).
--
-- Idempotent per repo policy (IF NOT EXISTS / DROP+ADD constraint). No
-- triggers, per repo convention.

BEGIN;

ALTER TABLE marketplace.orders
    ADD COLUMN IF NOT EXISTS delivered_quantity integer;

ALTER TABLE marketplace.orders
    DROP CONSTRAINT IF EXISTS orders_delivered_quantity_check;
ALTER TABLE marketplace.orders
    ADD CONSTRAINT orders_delivered_quantity_check
    CHECK (delivered_quantity IS NULL OR (delivered_quantity >= 1 AND delivered_quantity < quantity));

COMMIT;
