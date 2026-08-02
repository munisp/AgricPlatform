-- 006_market_data.sql — wave P1 market/commodity price feed storage.
-- Normalised observations from the FEWS NET / NiMet ingestion scheduler
-- (apps/api/src/modules/integrations/market-data-ingestion.service.ts).
-- All statements are idempotent (IF NOT EXISTS) so the migration is safe
-- to re-apply. The UNIQUE constraint backs the repository's upsertMany
-- replay dedupe; 003/004/005 are reserved for other waves.

BEGIN;

CREATE TABLE IF NOT EXISTS advisory.commodity_prices (
    id           text PRIMARY KEY,
    commodity    text NOT NULL,
    market       text NOT NULL,
    state        text NOT NULL,
    lga          text,
    price_ngn    numeric(14,2) NOT NULL CHECK (price_ngn >= 0),
    source       text NOT NULL,             -- FEWS NET|NiMet|manual|stub
    observed_at  timestamptz NOT NULL,
    ingested_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (commodity, market, source, observed_at)
);

CREATE INDEX IF NOT EXISTS commodity_prices_lookup_idx
    ON advisory.commodity_prices (commodity, state, observed_at DESC);

COMMIT;
