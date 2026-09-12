-- 062_lender_catalogue.sql — WP-G18: lender catalogue provenance.
--
-- finance.lenders (003_commerce_finance.sql) is the lender directory backing
-- the credit loan rail, but finance.service.ts lenderMatches served a
-- hardcoded 3-lender catalogue as real matches with no provenance. This
-- migration adds provenance columns and seeds the SAME three lenders as an
-- explicitly-labelled, unverified sample catalogue so the API can serve
-- matches from the database with honest source/verified labels:
--
--   source   — provenance of the catalogue row ('sample_catalogue' for the
--              built-in fixtures, 'admin_registered' for rows registered
--              through the admin API, future import rails use their own tag).
--   verified — false until the ops team vets the lender; unverified rows are
--              NEVER presented as vetted lender matches.
--
-- The DEFAULT 'admin_registered' applies only to pre-existing rows (the
-- admin API was historically the only creation path); the service layer
-- always writes source explicitly going forward.
--
-- Idempotent per repo policy (IF NOT EXISTS / ON CONFLICT). No triggers,
-- per repo convention. Additive only — 003 is never edited.

BEGIN;

ALTER TABLE finance.lenders
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'admin_registered';

ALTER TABLE finance.lenders
    ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;

-- Seed the three built-in catalogue lenders (identical shape to the former
-- hardcoded finance.service.ts catalogue and database/seed-data.ts
-- seedLenders), explicitly labelled as an UNVERIFIED SAMPLE. ON CONFLICT
-- relabels provenance only: a row that already exists (earlier seed path)
-- keeps its commercial terms but is never silently treated as verified.
INSERT INTO finance.lenders
    (id, name, product, min_ticket_kobo, max_ticket_kobo, min_score, criteria, is_active, source, verified)
VALUES
    ('lender-nyfn-coop', 'NYFN Cooperative Credit Window', 'Input financing (per season)',
     5000000, 50000000, 40,
     ARRAY['Credit score 40+', 'Verified membership'], true, 'sample_catalogue', false),
    ('lender-partner-mfi', 'Partner MFI Network', 'Asset financing (equipment)',
     25000000, 300000000, 60,
     ARRAY['Credit score 60+', 'Two verified vault documents'], true, 'sample_catalogue', false),
    ('lender-commercial-agri', 'Commercial Agri Desk', 'Working capital line',
     100000000, 1000000000, 75,
     ARRAY['Credit score 75+', 'Tier 2 KYC'], true, 'sample_catalogue', false)
ON CONFLICT (id) DO UPDATE
    SET source = 'sample_catalogue',
        verified = false,
        updated_at = now();

COMMIT;
