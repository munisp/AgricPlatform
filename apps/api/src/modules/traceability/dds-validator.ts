import { createHash } from 'node:crypto';
import {
  canonicalJson,
  verifyLotChain,
  type CommodityLot,
  type CustodyEvent,
  type LotPlotLink
} from './traceability.types.js';

/**
 * DDS Studio validation engine (stage 27 innovation 17) — PURE: no I/O, no
 * clock, no repository access. Given the assembled evidence bundle for a
 * shipment it evaluates every DDS requirement and returns a checklist with
 * pass/fail + basis per item. It NEVER auto-fixes evidence: incomplete
 * evidence fails loudly with the missing item named, and a DDS is never
 * auto-passed (the overall result is 'pass' only when every item passes).
 *
 * Determinism doctrine: the checklist and the evidence manifest depend only
 * on the stored evidence — the same shipment + evidence always yields the
 * same checklist and the same package hash.
 */

/** Everything the validator needs about one lot in the shipment. */
export interface DdsEvidenceLot {
  lot: CommodityLot;
  /** Custody chain in any order; the validator sorts by seq. */
  custodyEvents: CustodyEvent[];
  /** Immutable plot-geolocation snapshots linked to the lot. */
  plotLinks: LotPlotLink[];
}

export interface DdsEvidenceBundle {
  shipmentId: string;
  reference?: string;
  lots: DdsEvidenceLot[];
}

/** One DDS requirement verdict. `missing` names the exact gaps on failure. */
export interface DdsChecklistItem {
  requirement: string;
  passed: boolean;
  basis: string;
  missing?: string[];
}

export interface DdsValidationResult {
  shipmentId: string;
  lotCount: number;
  result: 'pass' | 'fail';
  items: DdsChecklistItem[];
}

/**
 * Nigeria bounding box used for the country-of-production geolocation check
 * (countryOfProduction is fixed 'NG' on the DDS; the platform has no
 * reverse-geocoder, so a bbox heuristic is the honest app-level check).
 */
export const NG_BBOX = { minLat: 4.0, maxLat: 14.0, minLong: 2.6, maxLong: 14.7 } as const;

function isFiniteCoord(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

function item(requirement: string, passed: boolean, basis: string, missing?: string[]): DdsChecklistItem {
  return missing && missing.length > 0 ? { requirement, passed, basis, missing } : { requirement, passed, basis };
}

/** The shipment must contain at least one lot. */
function checkShipmentHasLots(bundle: DdsEvidenceBundle): DdsChecklistItem {
  const passed = bundle.lots.length > 0;
  return item(
    'shipment_has_lots',
    passed,
    passed
      ? `Shipment '${bundle.shipmentId}' bundles ${bundle.lots.length} lot(s).`
      : 'A DDS requires at least one commodity lot; the shipment bundles none.',
    passed ? undefined : [`shipment:${bundle.shipmentId}`]
  );
}

/**
 * EUDR Annex II geolocation: every lot must carry at least one custody-linked
 * production plot with an immutable geolocation snapshot (the snapshot is a
 * copy taken at link time; later plot edits never rewrite it).
 */
function checkPlotSnapshots(bundle: DdsEvidenceLot): DdsChecklistItem {
  const passed = bundle.plotLinks.length > 0;
  return item(
    'lot_geolocation_snapshot',
    passed,
    passed
      ? `Lot '${bundle.lot.id}' has ${bundle.plotLinks.length} immutable plot geolocation snapshot(s) taken at link time.`
      : `Lot '${bundle.lot.id}' has no linked production plot — EUDR Annex II geolocation evidence is missing.`,
    passed ? undefined : [`lot:${bundle.lot.id}:plot_snapshot`]
  );
}

/**
 * Polygon-vs-point: platform snapshots are point geometries (lat/long +
 * optional H3 cell). EUDR accepts point geolocation for plots up to 4 ha;
 * larger plots require polygons, which this platform does not capture — the
 * basis states that bound explicitly instead of silently implying polygon
 * coverage. Fails only when a snapshot's coordinates are missing or out of
 * range (that is fabricated/broken evidence, not a format limitation).
 */
function checkPointGeometry(bundle: DdsEvidenceLot): DdsChecklistItem {
  const invalid = bundle.plotLinks
    .filter(
      (link) => !isFiniteCoord(link.latitude, -90, 90) || !isFiniteCoord(link.longitude, -180, 180)
    )
    .map((link) => `plot:${link.plotId}`);
  const passed = invalid.length === 0;
  return item(
    'geolocation_point_vs_polygon',
    passed,
    passed
      ? `All ${bundle.plotLinks.length} snapshot(s) for lot '${bundle.lot.id}' hold valid point coordinates. ` +
          'Snapshots are point geometries (EUDR permits points for plots up to 4 ha); the platform does not ' +
          'capture plot polygons or area, so the exporter must confirm every plot is within point-geometry eligibility.'
      : `Lot '${bundle.lot.id}' has plot snapshot(s) with missing or out-of-range coordinates: ${invalid.join(', ')}.`,
    invalid.length > 0 ? invalid : undefined
  );
}

/** Harvest-date windows must be ISO-parseable and ordered (end >= start). */
function checkHarvestWindow(bundle: DdsEvidenceLot): DdsChecklistItem {
  const start = Date.parse(bundle.lot.harvestWindowStart);
  const end = Date.parse(bundle.lot.harvestWindowEnd);
  const passed = Number.isFinite(start) && Number.isFinite(end) && end >= start;
  return item(
    'harvest_date_window',
    passed,
    passed
      ? `Lot '${bundle.lot.id}' harvest window ${bundle.lot.harvestWindowStart} → ${bundle.lot.harvestWindowEnd} is well-formed.`
      : `Lot '${bundle.lot.id}' harvest window is missing, unparseable or inverted ` +
          `(start='${bundle.lot.harvestWindowStart}', end='${bundle.lot.harvestWindowEnd}').`,
    passed ? undefined : [`lot:${bundle.lot.id}:harvest_window`]
  );
}

/**
 * Custody-chain continuity: the lot must have at least one custody event,
 * the per-lot seq must run 0..n-1 with no gaps, and the sha256 hash chain
 * must recompute cleanly (hash + prev-link per event). Gaps and broken links
 * are named per lot.
 */
function checkCustodyContinuity(bundle: DdsEvidenceLot): DdsChecklistItem {
  const events = [...bundle.custodyEvents].sort((a, b) => a.seq - b.seq);
  const missing: string[] = [];
  if (events.length === 0) {
    missing.push(`lot:${bundle.lot.id}:custody_events`);
  } else {
    for (let expected = 0; expected < events.length; expected += 1) {
      if (events[expected].seq !== expected) {
        missing.push(`lot:${bundle.lot.id}:custody_seq:${expected}`);
      }
    }
    const verification = verifyLotChain(bundle.lot.id, events);
    for (const event of verification.events) {
      if (!event.hashValid) {
        missing.push(`lot:${bundle.lot.id}:event_hash:${event.eventId}`);
      }
      if (!event.prevLinkValid) {
        missing.push(`lot:${bundle.lot.id}:prev_link:${event.eventId}`);
      }
    }
  }
  const passed = missing.length === 0;
  return item(
    'custody_chain_continuity',
    passed,
    passed
      ? `Lot '${bundle.lot.id}' custody chain runs ${events.length} event(s), seq 0..${events.length - 1} with no gaps, hash chain recomputes cleanly.`
      : `Lot '${bundle.lot.id}' custody chain is incomplete or broken: ${missing.join(', ')}.`,
    missing.length > 0 ? missing : undefined
  );
}

/** Commodity metadata: non-empty crop + unit, positive quantity per lot. */
function checkCommodityMetadata(bundle: DdsEvidenceLot): DdsChecklistItem {
  const missing: string[] = [];
  if (typeof bundle.lot.crop !== 'string' || bundle.lot.crop.trim().length === 0) {
    missing.push(`lot:${bundle.lot.id}:crop`);
  }
  if (typeof bundle.lot.unit !== 'string' || bundle.lot.unit.trim().length === 0) {
    missing.push(`lot:${bundle.lot.id}:unit`);
  }
  if (!Number.isFinite(bundle.lot.quantity) || bundle.lot.quantity <= 0) {
    missing.push(`lot:${bundle.lot.id}:quantity`);
  }
  const passed = missing.length === 0;
  return item(
    'commodity_metadata',
    passed,
    passed
      ? `Lot '${bundle.lot.id}' declares commodity '${bundle.lot.crop}', quantity ${bundle.lot.quantity} ${bundle.lot.unit}.`
      : `Lot '${bundle.lot.id}' commodity metadata is incomplete: ${missing.join(', ')}.`,
    missing.length > 0 ? missing : undefined
  );
}

/**
 * Country-of-production: the DDS fixes countryOfProduction='NG', so every
 * plot snapshot must sit inside the Nigeria bounding box (honest heuristic —
 * documented in the basis, not a geocoder).
 */
function checkCountryOfProduction(bundle: DdsEvidenceLot): DdsChecklistItem {
  const outside = bundle.plotLinks
    .filter(
      (link) =>
        !isFiniteCoord(link.latitude, NG_BBOX.minLat, NG_BBOX.maxLat) ||
        !isFiniteCoord(link.longitude, NG_BBOX.minLong, NG_BBOX.maxLong)
    )
    .map((link) => `plot:${link.plotId}`);
  const passed = bundle.plotLinks.length > 0 && outside.length === 0;
  const basisPrefix =
    `countryOfProduction is fixed 'NG'; snapshots are checked against the Nigeria bounding box ` +
    `(lat ${NG_BBOX.minLat}..${NG_BBOX.maxLat}, long ${NG_BBOX.minLong}..${NG_BBOX.maxLong}) — a bounding-box heuristic, not a reverse geocode. `;
  return item(
    'country_of_production_ng',
    passed,
    passed
      ? basisPrefix + `All ${bundle.plotLinks.length} snapshot(s) for lot '${bundle.lot.id}' fall inside it.`
      : basisPrefix +
          (bundle.plotLinks.length === 0
            ? `Lot '${bundle.lot.id}' has no plot snapshots to locate.`
            : `Snapshot(s) outside it for lot '${bundle.lot.id}': ${outside.join(', ')}.`),
    passed
      ? undefined
      : bundle.plotLinks.length === 0
        ? [`lot:${bundle.lot.id}:plot_snapshot`]
        : outside
  );
}

/**
 * Evaluates every DDS requirement against the evidence bundle. Pure and
 * deterministic: no clock, no I/O — same evidence in, same checklist out.
 */
export function validateDdsEvidence(bundle: DdsEvidenceBundle): DdsValidationResult {
  const items: DdsChecklistItem[] = [checkShipmentHasLots(bundle)];
  for (const lotBundle of bundle.lots) {
    items.push(
      checkPlotSnapshots(lotBundle),
      checkPointGeometry(lotBundle),
      checkHarvestWindow(lotBundle),
      checkCustodyContinuity(lotBundle),
      checkCommodityMetadata(lotBundle),
      checkCountryOfProduction(lotBundle)
    );
  }
  return {
    shipmentId: bundle.shipmentId,
    lotCount: bundle.lots.length,
    result: items.every((entry) => entry.passed) ? 'pass' : 'fail',
    items
  };
}

/* ------------------------------------------------------------------------ */
/* Evidence manifest + package hash (export determinism)                     */
/* ------------------------------------------------------------------------ */

/**
 * The exact evidence set a DDS package anchors. Contains only stored
 * evidence (no wall-clock fields): the same shipment + evidence always
 * produces the same manifest and therefore the same package hash.
 */
export interface DdsEvidenceManifest {
  shipmentId: string;
  reference: string | null;
  lots: Array<{
    lotId: string;
    crop: string;
    variety: string | null;
    harvestWindowStart: string;
    harvestWindowEnd: string;
    quantity: number;
    unit: string;
    custodyEventTypes: string[];
    custodyEventHashes: string[];
    headEventHash: string | null;
    plotSnapshots: Array<{
      linkId: string;
      plotId: string;
      latitude: number;
      longitude: number;
      h3Cell: string | null;
      linkedAt: string;
    }>;
  }>;
  checklist: DdsChecklistItem[];
}

/** Builds the deterministic evidence manifest for a validated bundle. */
export function buildEvidenceManifest(
  bundle: DdsEvidenceBundle,
  checklist: DdsChecklistItem[]
): DdsEvidenceManifest {
  return {
    shipmentId: bundle.shipmentId,
    reference: bundle.reference ?? null,
    lots: bundle.lots.map(({ lot, custodyEvents, plotLinks }) => {
      const ordered = [...custodyEvents].sort((a, b) => a.seq - b.seq);
      return {
        lotId: lot.id,
        crop: lot.crop,
        variety: lot.variety ?? null,
        harvestWindowStart: lot.harvestWindowStart,
        harvestWindowEnd: lot.harvestWindowEnd,
        quantity: lot.quantity,
        unit: lot.unit,
        custodyEventTypes: [...new Set(ordered.map((event) => event.type))].sort(),
        custodyEventHashes: ordered.map((event) => event.eventHash),
        headEventHash: ordered.length > 0 ? ordered[ordered.length - 1].eventHash : null,
        plotSnapshots: plotLinks.map((link) => ({
          linkId: link.id,
          plotId: link.plotId,
          latitude: link.latitude,
          longitude: link.longitude,
          h3Cell: link.h3Cell ?? null,
          linkedAt: link.linkedAt
        }))
      };
    }),
    checklist
  };
}

/** sha256 hex over the canonical JSON of the evidence manifest. */
export function computePackageHash(manifest: DdsEvidenceManifest): string {
  return createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex');
}
