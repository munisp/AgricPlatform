-- 005_attendance_exports.sql — QR attendance scan metadata (Wave P3).
--
-- The chapters schema already stores attendance in chapters.event_participation
-- (single row per (event_id, user_id), status 'attended', UNIQUE constraint),
-- so per migration policy we EXTEND that table with QR scan metadata instead
-- of duplicating attendance storage in a second table. The UNIQUE
-- (event_id, user_id) constraint continues to enforce the duplicate-scan
-- rejection at the database level; the API maps it to a 409 response.
--
-- Analytics export auditing reuses the hash-chained admin.audit_events table
-- (001/002), so no export-specific table is needed here.
--
-- All statements are idempotent (IF NOT EXISTS) and safe to re-apply.

BEGIN;

-- QR scan check-in metadata (Wave P3): when the member checked in via a
-- signed attendance code and which scanner (chapter lead / device) recorded it.
ALTER TABLE chapters.event_participation
    ADD COLUMN IF NOT EXISTS scanned_at timestamptz,
    ADD COLUMN IF NOT EXISTS scanner_id text;

COMMIT;
