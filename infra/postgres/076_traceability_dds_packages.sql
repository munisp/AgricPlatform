-- 076_traceability_dds_packages.sql — DDS Studio (stage 27, innovation 17):
-- assembled EUDR due-diligence statement packages. A package is the operator
-- workspace over an existing traceability shipment: it carries the validation
-- checklist (per-requirement pass/fail + basis, produced by the pure
-- dds-validator engine — never auto-fixed) and, once exported, the
-- package_hash anchoring the EXACT evidence set exported (audit doctrine:
-- the hash is computed over the canonical evidence manifest — shipment id,
-- lot ids, custody head hashes, immutable plot snapshots and the final
-- checklist — so any later evidence rewrite yields a different hash).
--
-- Lifecycle: draft → validated → exported. Validation may fail — the
-- checklist is stored with the failing basis and the package STAYS in draft;
-- a DDS is never auto-passed. Export is a guarded status CAS
-- (UPDATE … WHERE status = 'validated'); exported packages have no further
-- write path in application code (immutability after export). Idempotent
-- (IF NOT EXISTS), no triggers.

BEGIN;

CREATE TABLE IF NOT EXISTS traceability.dds_packages (
    id                  text PRIMARY KEY,
    shipment_id         text NOT NULL REFERENCES traceability.shipments(id),
    status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','validated','exported')),
    checklist           jsonb NOT NULL DEFAULT '[]'::jsonb,
    package_hash        text,
    exporter_partner_id text,
    created_by          text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    exported_at         timestamptz
);

CREATE INDEX IF NOT EXISTS dds_packages_shipment_idx
    ON traceability.dds_packages (shipment_id);
CREATE INDEX IF NOT EXISTS dds_packages_exporter_idx
    ON traceability.dds_packages (exporter_partner_id);
CREATE INDEX IF NOT EXISTS dds_packages_status_idx
    ON traceability.dds_packages (status);

COMMIT;
