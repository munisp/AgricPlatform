-- 019a_listing_certified_link.sql — Marketplace listing → certified
-- livestock listing link (G18). Numbered 019a because 019 is taken by the
-- parallel analytics wave; lexical order keeps it after every 01x migration.
--
-- A marketplace listing for livestock can point at the certified listing it
-- was created from, so buyer-facing provenance badges use the REAL
-- certification link instead of a crop-term heuristic. Nullable FK: crop /
-- equipment listings simply leave it NULL. Idempotent per migration policy.

BEGIN;

ALTER TABLE marketplace.listings
    ADD COLUMN IF NOT EXISTS certified_listing_id text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'listings_certified_listing_fkey'
    ) THEN
        ALTER TABLE marketplace.listings
            ADD CONSTRAINT listings_certified_listing_fkey
            FOREIGN KEY (certified_listing_id)
            REFERENCES livestock.certified_listings (id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS listings_certified_listing_idx
    ON marketplace.listings (certified_listing_id)
    WHERE certified_listing_id IS NOT NULL;

COMMIT;
