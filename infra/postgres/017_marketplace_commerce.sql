-- 017_marketplace_commerce.sql — Wave M marketplace commerce depth
-- (Medusa-pattern innovations adopted natively):
--   1. Listing variants & SKUs (per-variant price + stock)
--   2. Promotions engine (coupon codes + automatic promotions, redemptions)
--   3. Price lists (buyer-group-scoped variant price overrides)
--   4. Buyer groups + membership
--   5. Order edit & cancel-with-restock support (order_extensions side table)
--   6. RMA / returns (requested → approved → received → refunded|rejected)
--   7. Draft orders (agent/admin-created, buyer-confirmed)
--   8. Sales channels (web|mobile|agent on order_extensions)
--   9. Verified-purchase product reviews + materialized seller ratings
-- Money is integer kobo (bigint) throughout. Idempotent (IF NOT EXISTS)
-- per migration policy. Text PKs match the app-generated id contract.

BEGIN;

-- ---------------------------------------------------------------------------
-- marketplace: listing variants (SKU, own price + stock per variant)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.listing_variants (
    id              text PRIMARY KEY,
    listing_id      text NOT NULL REFERENCES marketplace.listings(id),
    sku             text NOT NULL UNIQUE,
    name            text NOT NULL,
    attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
    price_kobo      bigint NOT NULL CHECK (price_kobo >= 0),
    quantity        integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listing_variants_listing_idx
    ON marketplace.listing_variants (listing_id);

-- ---------------------------------------------------------------------------
-- marketplace: buyer groups + membership (admin/agent-managed)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.buyer_groups (
    id              text PRIMARY KEY,
    name            text NOT NULL UNIQUE,
    description     text,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace.buyer_group_memberships (
    id              text PRIMARY KEY,
    group_id        text NOT NULL REFERENCES marketplace.buyer_groups(id),
    user_id         text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS buyer_group_memberships_user_idx
    ON marketplace.buyer_group_memberships (user_id);

-- ---------------------------------------------------------------------------
-- marketplace: price lists (validity-windowed variant price overrides)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.price_lists (
    id              text PRIMARY KEY,
    name            text NOT NULL UNIQUE,
    description     text,
    buyer_group_id  text REFERENCES marketplace.buyer_groups(id),
    starts_at       timestamptz,
    ends_at         timestamptz,
    priority        integer NOT NULL DEFAULT 0,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace.price_list_entries (
    id              text PRIMARY KEY,
    price_list_id   text NOT NULL REFERENCES marketplace.price_lists(id),
    variant_id      text NOT NULL REFERENCES marketplace.listing_variants(id),
    price_kobo      bigint NOT NULL CHECK (price_kobo >= 0),
    UNIQUE (price_list_id, variant_id)
);
CREATE INDEX IF NOT EXISTS price_list_entries_variant_idx
    ON marketplace.price_list_entries (variant_id);

-- ---------------------------------------------------------------------------
-- marketplace: promotions (coupon codes + automatic) and redemptions.
-- percentage values are basis points (10000 = 100%); fixed values are kobo.
-- used_count is maintained by a guarded conditional UPDATE so concurrent
-- checkouts cannot exceed usage_limit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.promotions (
    id              text PRIMARY KEY,
    code            text UNIQUE,
    name            text NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('percentage','fixed')),
    value           bigint NOT NULL CHECK (value >= 0),
    automatic       boolean NOT NULL DEFAULT false,
    min_order_kobo  bigint CHECK (min_order_kobo >= 0),
    listing_id      text REFERENCES marketplace.listings(id),
    buyer_group_id  text REFERENCES marketplace.buyer_groups(id),
    usage_limit     integer CHECK (usage_limit > 0),
    used_count      integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
    starts_at       timestamptz,
    ends_at         timestamptz,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promotions_code_idx ON marketplace.promotions (code);
CREATE INDEX IF NOT EXISTS promotions_automatic_idx
    ON marketplace.promotions (automatic) WHERE is_active;

CREATE TABLE IF NOT EXISTS marketplace.promotion_redemptions (
    id              text PRIMARY KEY,
    promotion_id    text NOT NULL REFERENCES marketplace.promotions(id),
    order_id        text NOT NULL,
    discount_kobo   bigint NOT NULL CHECK (discount_kobo >= 0),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (promotion_id, order_id)
);
CREATE INDEX IF NOT EXISTS promotion_redemptions_order_idx
    ON marketplace.promotion_redemptions (order_id);

-- ---------------------------------------------------------------------------
-- marketplace: order extensions (variant, channel, kobo totals, draft origin)
-- Side table so the shared marketplace.orders contract stays untouched.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.order_extensions (
    order_id        text PRIMARY KEY REFERENCES marketplace.orders(id),
    variant_id      text REFERENCES marketplace.listing_variants(id),
    channel         text NOT NULL DEFAULT 'web'
                    CHECK (channel IN ('web','mobile','agent')),
    unit_price_kobo bigint NOT NULL DEFAULT 0 CHECK (unit_price_kobo >= 0),
    subtotal_kobo   bigint NOT NULL DEFAULT 0 CHECK (subtotal_kobo >= 0),
    discount_kobo   bigint NOT NULL DEFAULT 0 CHECK (discount_kobo >= 0),
    total_kobo      bigint NOT NULL DEFAULT 0 CHECK (total_kobo >= 0),
    draft_id        text,
    created_by      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_extensions_channel_idx
    ON marketplace.order_extensions (channel);
CREATE INDEX IF NOT EXISTS order_extensions_variant_idx
    ON marketplace.order_extensions (variant_id);

-- ---------------------------------------------------------------------------
-- marketplace: RMA / return requests
-- (requested → approved → received → refunded|rejected)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.return_requests (
    id              text PRIMARY KEY,
    order_id        text NOT NULL REFERENCES marketplace.orders(id),
    buyer_id        text NOT NULL,
    reason          text NOT NULL,
    status          text NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested','approved','received','refunded','rejected')),
    restock         boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    resolved_at     timestamptz
);
CREATE INDEX IF NOT EXISTS return_requests_order_idx ON marketplace.return_requests (order_id);
CREATE INDEX IF NOT EXISTS return_requests_status_idx ON marketplace.return_requests (status);
CREATE INDEX IF NOT EXISTS return_requests_buyer_idx ON marketplace.return_requests (buyer_id);

-- ---------------------------------------------------------------------------
-- marketplace: draft orders (agent/admin-created, buyer-confirmed)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.draft_orders (
    id              text PRIMARY KEY,
    listing_id      text NOT NULL REFERENCES marketplace.listings(id),
    variant_id      text REFERENCES marketplace.listing_variants(id),
    buyer_id        text NOT NULL,
    seller_id       text NOT NULL,
    quantity        integer NOT NULL CHECK (quantity > 0),
    unit_price_kobo bigint NOT NULL CHECK (unit_price_kobo >= 0),
    status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','confirmed','discarded')),
    order_id        text,
    created_by      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS draft_orders_buyer_idx ON marketplace.draft_orders (buyer_id, status);

-- ---------------------------------------------------------------------------
-- marketplace: verified-purchase product reviews + materialized seller ratings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace.product_reviews (
    id              text PRIMARY KEY,
    listing_id      text NOT NULL REFERENCES marketplace.listings(id),
    order_id        text NOT NULL REFERENCES marketplace.orders(id),
    buyer_id        text NOT NULL,
    rating          smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment         text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (order_id, buyer_id)
);
CREATE INDEX IF NOT EXISTS product_reviews_listing_idx
    ON marketplace.product_reviews (listing_id);

CREATE TABLE IF NOT EXISTS marketplace.seller_ratings (
    user_id         text PRIMARY KEY,
    review_count    integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
    rating_sum      bigint NOT NULL DEFAULT 0 CHECK (rating_sum >= 0),
    average         numeric(3,2) NOT NULL DEFAULT 0,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMIT;
