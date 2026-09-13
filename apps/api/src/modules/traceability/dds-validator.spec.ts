import { describe, expect, it } from 'vitest';
import {
  buildEvidenceManifest,
  computePackageHash,
  validateDdsEvidence,
  type DdsEvidenceBundle,
  type DdsEvidenceLot
} from './dds-validator.js';
import {
  computeEventHash,
  GENESIS_PREV_HASH,
  hashPayloadOf,
  type CommodityLot,
  type CustodyEvent,
  type CustodyEventType,
  type LotPlotLink
} from './traceability.types.js';

/**
 * DDS Studio validator known-answer suite (stage 27 innovation 17):
 *   - a complete shipment passes every requirement;
 *   - a custody-chain gap fails loudly with the missing item named;
 *   - editing the live plot AFTER linking still passes because the snapshot
 *     is immutable (regression guard for the core design decision);
 *   - the evidence manifest + package hash are deterministic and change when
 *     the evidence changes.
 */

function makeLot(overrides: Partial<CommodityLot> = {}): CommodityLot {
  return {
    id: 'lot-1',
    ownerUserId: 'user-farmer',
    crop: 'Cocoa',
    harvestWindowStart: '2026-01-01T00:00:00.000Z',
    harvestWindowEnd: '2026-03-01T00:00:00.000Z',
    quantity: 500,
    unit: 'kg',
    status: 'active',
    parentLotIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

/** Builds a valid hash-chained event at the given seq (chain position). */
function makeEvent(
  lotId: string,
  seq: number,
  type: CustodyEventType,
  prevEventHash: string,
  occurredAt: string
): CustodyEvent {
  const unsigned = {
    lotId,
    seq,
    type,
    actorId: 'user-farmer',
    occurredAt,
    latitude: 11.0855,
    longitude: 7.7199,
    parentLotIds: [] as string[],
    prevEventHash
  };
  return {
    id: `evt-${lotId}-${seq}`,
    ...unsigned,
    eventHash: computeEventHash(hashPayloadOf(unsigned)),
    createdAt: occurredAt
  };
}

function makeChain(lotId: string): CustodyEvent[] {
  const first = makeEvent(lotId, 0, 'CREATED', GENESIS_PREV_HASH, '2026-02-01T00:00:00.000Z');
  const second = makeEvent(lotId, 1, 'SHIPPED', first.eventHash, '2026-02-15T00:00:00.000Z');
  return [first, second];
}

function makeSnapshot(lotId: string, overrides: Partial<LotPlotLink> = {}): LotPlotLink {
  return {
    id: `lpl-${lotId}-1`,
    lotId,
    plotId: 'plot-1',
    plotOwnerUserId: 'user-farmer',
    plotName: 'Zaria North Plot',
    latitude: 11.0855,
    longitude: 7.7199,
    linkedAt: '2026-01-10T00:00:00.000Z',
    linkedBy: 'user-farmer',
    ...overrides
  };
}

function completeBundle(): DdsEvidenceBundle {
  return {
    shipmentId: 'tsh-1',
    reference: 'EXP-2026-001',
    lots: [{ lot: makeLot(), custodyEvents: makeChain('lot-1'), plotLinks: [makeSnapshot('lot-1')] }]
  };
}

function requirementsOf(bundle: DdsEvidenceBundle) {
  const validation = validateDdsEvidence(bundle);
  return { validation, byKey: new Map(validation.items.map((entry) => [entry.requirement, entry])) };
}

describe('validateDdsEvidence — known answers', () => {
  it('passes a complete shipment (every requirement pass, overall pass)', () => {
    const { validation, byKey } = requirementsOf(completeBundle());
    expect(validation.result).toBe('pass');
    expect(validation.lotCount).toBe(1);
    for (const requirement of [
      'shipment_has_lots',
      'lot_geolocation_snapshot',
      'geolocation_point_vs_polygon',
      'harvest_date_window',
      'custody_chain_continuity',
      'commodity_metadata',
      'country_of_production_ng'
    ]) {
      expect(byKey.get(requirement)?.passed, requirement).toBe(true);
      expect(byKey.get(requirement)?.basis.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic: the same bundle yields the identical checklist twice', () => {
    expect(validateDdsEvidence(completeBundle())).toEqual(validateDdsEvidence(completeBundle()));
  });

  it('fails loudly with the named item when the custody chain has a seq gap', () => {
    const bundle = completeBundle();
    // Drop seq 1 and renumber nothing: chain holds seq 0 and seq 2 only.
    const gapped = makeChain('lot-1');
    const third = makeEvent('lot-1', 2, 'RECEIVED', gapped[1].eventHash, '2026-02-20T00:00:00.000Z');
    bundle.lots[0].custodyEvents = [gapped[0], third];

    const { validation, byKey } = requirementsOf(bundle);
    expect(validation.result).toBe('fail');
    const continuity = byKey.get('custody_chain_continuity')!;
    expect(continuity.passed).toBe(false);
    expect(continuity.missing).toContain('lot:lot-1:custody_seq:1');
    expect(continuity.basis).toContain('lot:lot-1:custody_seq:1');
  });

  it('fails loudly when a lot has no custody events at all', () => {
    const bundle = completeBundle();
    bundle.lots[0].custodyEvents = [];
    const { validation, byKey } = requirementsOf(bundle);
    expect(validation.result).toBe('fail');
    expect(byKey.get('custody_chain_continuity')!.missing).toContain('lot:lot-1:custody_events');
  });

  it('fails loudly naming the lot when no plot snapshot is linked', () => {
    const bundle = completeBundle();
    bundle.lots[0].plotLinks = [];
    const { validation, byKey } = requirementsOf(bundle);
    expect(validation.result).toBe('fail');
    expect(byKey.get('lot_geolocation_snapshot')!.missing).toContain('lot:lot-1:plot_snapshot');
  });

  it('fails when a snapshot sits outside the Nigeria bounding box', () => {
    const bundle = completeBundle();
    bundle.lots[0].plotLinks = [makeSnapshot('lot-1', { latitude: 48.8566, longitude: 2.3522 })];
    const { validation, byKey } = requirementsOf(bundle);
    expect(validation.result).toBe('fail');
    expect(byKey.get('country_of_production_ng')!.missing).toContain('plot:plot-1');
  });

  it('fails on an inverted harvest window, naming the lot', () => {
    const bundle = completeBundle();
    bundle.lots[0].lot = makeLot({
      harvestWindowStart: '2026-03-01T00:00:00.000Z',
      harvestWindowEnd: '2026-01-01T00:00:00.000Z'
    });
    const { validation, byKey } = requirementsOf(bundle);
    expect(validation.result).toBe('fail');
    expect(byKey.get('harvest_date_window')!.missing).toContain('lot:lot-1:harvest_window');
  });

  it('fails on a tampered custody event hash (chain surgery surfaces)', () => {
    const bundle = completeBundle();
    const forged = { ...bundle.lots[0].custodyEvents[1], note: 'rewritten history' };
    bundle.lots[0].custodyEvents = [bundle.lots[0].custodyEvents[0], forged];
    const { validation, byKey } = requirementsOf(bundle);
    expect(validation.result).toBe('fail');
    expect(byKey.get('custody_chain_continuity')!.missing).toContain(`lot:lot-1:event_hash:${forged.id}`);
  });

  it('REGRESSION GUARD: editing the live plot after linking still passes — the snapshot is immutable', () => {
    // The snapshot was copied at link time (11.0855, 7.7199 — inside NG).
    const bundle = completeBundle();
    const before = validateDdsEvidence(bundle);
    // The live plot row is then edited (moved outside the NG bbox, renamed).
    // The validator composes over the SNAPSHOT store only, so the live edit
    // cannot rewrite historical evidence: the same snapshot still validates.
    const livePlotAfterEdit = { id: 'plot-1', centroidLat: 48.8566, centroidLong: 2.3522, name: 'Moved' };
    void livePlotAfterEdit; // the validator never reads the live plot — by design
    const after = validateDdsEvidence(bundle);
    expect(after).toEqual(before);
    expect(after.result).toBe('pass');
    expect(after.items.find((entry) => entry.requirement === 'lot_geolocation_snapshot')!.basis).toContain(
      'immutable'
    );
  });

  it('never auto-passes: an empty shipment fails with the shipment named', () => {
    const bundle: DdsEvidenceBundle = { shipmentId: 'tsh-empty', lots: [] };
    const { validation, byKey } = requirementsOf(bundle);
    expect(validation.result).toBe('fail');
    expect(byKey.get('shipment_has_lots')!.missing).toContain('shipment:tsh-empty');
  });

  it('aggregates per-lot failures across multi-lot shipments', () => {
    const bundle = completeBundle();
    const second: DdsEvidenceLot = {
      lot: makeLot({ id: 'lot-2' }),
      custodyEvents: makeChain('lot-2'),
      plotLinks: [] // lot-2 lacks geolocation evidence
    };
    bundle.lots.push(second);
    const { validation, byKey } = requirementsOf(bundle);
    expect(validation.result).toBe('fail');
    const failures = validation.items.filter((entry) => !entry.passed);
    expect(failures.map((entry) => entry.requirement)).toEqual([
      'lot_geolocation_snapshot',
      'country_of_production_ng'
    ]);
    expect(byKey.get('lot_geolocation_snapshot')!.missing).toContain('lot:lot-2:plot_snapshot');
  });
});

describe('evidence manifest + package hash — export determinism', () => {
  it('same shipment + evidence → same package_hash', () => {
    const bundle = completeBundle();
    const checklist = validateDdsEvidence(bundle).items;
    const first = computePackageHash(buildEvidenceManifest(bundle, checklist));
    const second = computePackageHash(buildEvidenceManifest(completeBundle(), checklist));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second);
  });

  it('is independent of input event ordering (canonicalised by seq)', () => {
    const bundle = completeBundle();
    const checklist = validateDdsEvidence(bundle).items;
    const shuffled = completeBundle();
    shuffled.lots[0].custodyEvents = [...shuffled.lots[0].custodyEvents].reverse();
    expect(computePackageHash(buildEvidenceManifest(shuffled, checklist))).toBe(
      computePackageHash(buildEvidenceManifest(bundle, checklist))
    );
  });

  it('any evidence change yields a different package_hash', () => {
    const bundle = completeBundle();
    const checklist = validateDdsEvidence(bundle).items;
    const baseline = computePackageHash(buildEvidenceManifest(bundle, checklist));

    const changed = completeBundle();
    changed.lots[0].custodyEvents = [
      ...changed.lots[0].custodyEvents,
      makeEvent('lot-1', 2, 'RECEIVED', changed.lots[0].custodyEvents[1].eventHash, '2026-02-20T00:00:00.000Z')
    ];
    expect(computePackageHash(buildEvidenceManifest(changed, checklist))).not.toBe(baseline);

    const moved = completeBundle();
    moved.lots[0].plotLinks = [makeSnapshot('lot-1', { latitude: 11.09 })];
    expect(computePackageHash(buildEvidenceManifest(moved, checklist))).not.toBe(baseline);
  });
});
