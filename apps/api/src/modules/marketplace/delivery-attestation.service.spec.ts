import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EscrowRecord, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryDeliveryAttestationRepository,
  InMemoryDeliveryAttestationRepository
} from '../../database/repositories/delivery-attestation.repository.js';
import { createInMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { H3Service } from '../geo/h3.service.js';
import {
  DeliveryAttestationService,
  type GeoSealedDeliveryOptions
} from './delivery-attestation.service.js';
import {
  computeAttestationHash,
  attestationHashPayloadOf,
  GENESIS_PREV_HASH,
  verifyAttestationChain,
  type DeliveryAttestation
} from './delivery-attestation.types.js';
import { DELIVERY_CONFIRM_WINDOW_MS, EscrowService } from './escrow.service.js';

const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };
const seller: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const agent: Pick<User, 'id' | 'roles'> = { id: 'user-agent-1', roles: ['agent'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['student'] };

/**
 * Known-answer H3 vectors (res 9, h3-js):
 *   drop point (12.0022, 8.5920)          → cell 89580a4ed37ffff  (Kano)
 *   ring-1 neighbour centre               → cell 89580a4ed33ffff
 *   Lagos (6.5244, 3.3792)                → cell 89589c984c7ffff  (outside ring 1)
 */
const DROP = { lat: 12.0022, lng: 8.5920 };
const DROP_CELL = '89580a4ed37ffff';
const NEIGHBOUR = { lat: 12.00203659835979, lng: 8.58886495430616 };
const NEIGHBOUR_CELL = '89580a4ed33ffff';
const FAR = { lat: 6.5244, lng: 3.3792 };
const FAR_CELL = '89589c984c7ffff';

function makeService(options: GeoSealedDeliveryOptions = { requireGps: false }) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const orders = createInMemoryOrderRepository();
  const escrows = createInMemoryEscrowRepository();
  const attestations = createInMemoryDeliveryAttestationRepository();
  const escrow = new EscrowService(events, orders, escrows);
  const service = new DeliveryAttestationService(
    events,
    orders,
    escrows,
    attestations,
    escrow,
    new H3Service(),
    options
  );
  return { service, escrow, events, attestations };
}

/** Seed order 'order-buyer-cassava': ₦370,000 total, escrowRequired, confirmed. */
async function heldGeoSealedEscrow(
  ctx: ReturnType<typeof makeService>,
  radiusCells = 1
): Promise<EscrowRecord> {
  const record = await ctx.escrow.holdForOrder('order-buyer-cassava', buyer.id);
  await ctx.service.setDeliveryPoint('order-buyer-cassava', { ...DROP, radiusCells }, buyer);
  return record;
}

describe('DeliveryAttestationService — H3 containment known-answer', () => {
  it('pins the drop point as a server-computed res-9 cell (never raw coordinates)', async () => {
    const ctx = makeService();
    const record = await ctx.escrow.holdForOrder('order-buyer-cassava', buyer.id);
    const updated = await ctx.service.setDeliveryPoint(
      'order-buyer-cassava',
      { ...DROP, radiusCells: 1 },
      buyer
    );
    expect(updated.deliveryPointH3).toBe(DROP_CELL);
    expect(updated.geofenceRadiusCells).toBe(1);
    // The escrow record carries the cell only — no lat/lng columns exist on it.
    expect(Object.keys(updated)).not.toContain('lat');
    expect(Object.keys(updated)).not.toContain('lng');
    expect((await ctx.escrow.escrowForOrder('order-buyer-cassava'))?.id).toBe(record.id);
  });

  it('accepts an attestation inside the ring and advances held → delivered_pending_confirm', async () => {
    const ctx = makeService();
    await heldGeoSealedEscrow(ctx, 1);
    const record = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    const attestation = await ctx.service.attestDelivery(
      record.id,
      { ...NEIGHBOUR, deviceBasis: 'gps' },
      buyer
    );
    expect(attestation.h3Res9).toBe(NEIGHBOUR_CELL);
    expect(attestation.withinGeofence).toBe(true);
    const after = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    expect(after.status).toBe('delivered_pending_confirm');
    // gps basis gets a confirm window for the auto-release sweep.
    expect(after.deliveryConfirmUntil).toBeDefined();
  });

  it('records an out-of-geofence attestation and rejects 409 GEO_FENCE_MISMATCH without advancing state', async () => {
    const ctx = makeService();
    await heldGeoSealedEscrow(ctx, 1);
    const record = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    await expect(
      ctx.service.attestDelivery(record.id, { ...FAR, deviceBasis: 'gps' }, buyer)
    ).rejects.toThrowError(/GEO_FENCE_MISMATCH/);
    const stored = await ctx.attestations.listByEscrow(record.id);
    expect(stored).toHaveLength(1); // recorded honestly as evidence
    expect(stored[0].h3Res9).toBe(FAR_CELL);
    expect(stored[0].withinGeofence).toBe(false);
    expect((await ctx.escrow.escrowForOrder('order-buyer-cassava'))!.status).toBe('held');
  });

  it('treats radius 0 as the exact drop cell (ring neighbour is OUT)', async () => {
    const ctx = makeService();
    await heldGeoSealedEscrow(ctx, 0);
    const record = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    await expect(
      ctx.service.attestDelivery(record.id, { ...NEIGHBOUR, deviceBasis: 'gps' }, buyer)
    ).rejects.toThrowError(ConflictException);
    const exact = await ctx.service.attestDelivery(
      record.id,
      { ...DROP, deviceBasis: 'gps' },
      buyer
    );
    expect(exact.h3Res9).toBe(DROP_CELL);
    expect(exact.withinGeofence).toBe(true);
    expect((await ctx.escrow.escrowForOrder('order-buyer-cassava'))!.status).toBe(
      'delivered_pending_confirm'
    );
  });

  it('never trusts a client-supplied within_geofence claim — the server recomputes containment', async () => {
    const ctx = makeService();
    await heldGeoSealedEscrow(ctx, 1);
    const record = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    // A forged payload claiming within_geofence=true from Lagos still fails.
    await expect(
      ctx.service.attestDelivery(
        record.id,
        { ...FAR, deviceBasis: 'gps', within_geofence: true } as never,
        buyer
      )
    ).rejects.toThrowError(/GEO_FENCE_MISMATCH/);
    // And a forged within_geofence=false from inside the ring still verifies.
    const attestation = await ctx.service.attestDelivery(
      record.id,
      { ...DROP, deviceBasis: 'gps', within_geofence: false } as never,
      buyer
    );
    expect(attestation.withinGeofence).toBe(true);
  });

  it('rejects delivery-point radius outside the column CHECK bounds (0..10 cells)', async () => {
    const ctx = makeService();
    await ctx.escrow.holdForOrder('order-buyer-cassava', buyer.id);
    await expect(
      ctx.service.setDeliveryPoint('order-buyer-cassava', { ...DROP, radiusCells: 11 }, buyer)
    ).rejects.toThrowError(BadRequestException);
    await expect(
      ctx.service.setDeliveryPoint('order-buyer-cassava', { ...DROP, radiusCells: -1 }, buyer)
    ).rejects.toThrowError(BadRequestException);
  });

  it('scopes delivery-point writes to the buyer (or admin) and attestations to buyer/agent', async () => {
    const ctx = makeService();
    await ctx.escrow.holdForOrder('order-buyer-cassava', buyer.id);
    await expect(
      ctx.service.setDeliveryPoint('order-buyer-cassava', { ...DROP }, seller)
    ).rejects.toThrowError(ForbiddenException);
    await ctx.service.setDeliveryPoint('order-buyer-cassava', { ...DROP }, buyer);
    const record = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    await expect(
      ctx.service.attestDelivery(record.id, { ...DROP, deviceBasis: 'gps' }, outsider)
    ).rejects.toThrowError(ForbiddenException);
    // An agent may attest (delivery attestation as a paid micro-service).
    const attestation = await ctx.service.attestDelivery(
      record.id,
      { ...DROP, deviceBasis: 'network' },
      agent
    );
    expect(attestation.role).toBe('agent');
    expect(attestation.withinGeofence).toBe(true);
  });

  it('refuses attestation on an escrow that never opted in (no delivery point)', async () => {
    const ctx = makeService();
    await ctx.escrow.holdForOrder('order-buyer-cassava', buyer.id);
    const record = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    await expect(
      ctx.service.attestDelivery(record.id, { ...DROP, deviceBasis: 'gps' }, buyer)
    ).rejects.toThrowError(/not geo-sealed/);
  });
});

describe('DeliveryAttestationService — device-basis policy', () => {
  it('manual basis advances state but gets NO confirm window (buyer confirm required)', async () => {
    const ctx = makeService({ requireGps: false });
    await heldGeoSealedEscrow(ctx, 1);
    const record = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    const attestation = await ctx.service.attestDelivery(
      record.id,
      { ...DROP, deviceBasis: 'manual' },
      buyer
    );
    expect(attestation.deviceBasis).toBe('manual'); // recorded honestly
    const after = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    expect(after.status).toBe('delivered_pending_confirm');
    expect(after.deliveryConfirmUntil).toBeUndefined();
    // The sweep never auto-releases a manual-only delivery, even far past any window.
    const released = await ctx.escrow.releaseDeliveredEscrows(
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    );
    expect(released).toHaveLength(0);
    expect((await ctx.escrow.escrowForOrder('order-buyer-cassava'))!.status).toBe(
      'delivered_pending_confirm'
    );
    // The buyer confirms explicitly instead.
    await ctx.escrow.transition(after.id, 'released', buyer);
    expect((await ctx.escrow.escrowForOrder('order-buyer-cassava'))!.status).toBe('released');
  });

  it('rejects manual-basis attestation when policy requires gps (recorded, 422, state unchanged)', async () => {
    const ctx = makeService({ requireGps: true });
    await heldGeoSealedEscrow(ctx, 1);
    const record = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    await expect(
      ctx.service.attestDelivery(record.id, { ...DROP, deviceBasis: 'manual' }, buyer)
    ).rejects.toThrowError(/DEVICE_BASIS_REJECTED/);
    await expect(
      ctx.service.attestDelivery(record.id, { ...DROP, deviceBasis: 'manual' }, buyer)
    ).rejects.toThrowError(UnprocessableEntityException);
    const stored = await ctx.attestations.listByEscrow(record.id);
    expect(stored).toHaveLength(2);
    expect(stored.every((a) => a.deviceBasis === 'manual')).toBe(true); // recorded honestly
    expect((await ctx.escrow.escrowForOrder('order-buyer-cassava'))!.status).toBe('held');
    // A gps attestation under the same policy succeeds.
    const gps = await ctx.service.attestDelivery(record.id, { ...DROP, deviceBasis: 'gps' }, buyer);
    expect(gps.withinGeofence).toBe(true);
    expect((await ctx.escrow.escrowForOrder('order-buyer-cassava'))!.status).toBe(
      'delivered_pending_confirm'
    );
  });
});

describe('DeliveryAttestationService — confirm-window auto-release', () => {
  it('auto-releases exactly when the confirm window has elapsed (edge: now == deadline)', async () => {
    const ctx = makeService();
    await heldGeoSealedEscrow(ctx, 1);
    const record = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    await ctx.service.attestDelivery(record.id, { ...DROP, deviceBasis: 'gps' }, buyer);
    const pending = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    const deadline = pending.deliveryConfirmUntil!;
    expect(new Date(deadline).getTime() - Date.now()).toBeGreaterThan(
      DELIVERY_CONFIRM_WINDOW_MS - 60_000
    );
    // One millisecond before the deadline: not released.
    const early = new Date(new Date(deadline).getTime() - 1).toISOString();
    expect(await ctx.escrow.releaseDeliveredEscrows(early)).toHaveLength(0);
    expect((await ctx.escrow.escrowForOrder('order-buyer-cassava'))!.status).toBe(
      'delivered_pending_confirm'
    );
    // Exactly at the deadline: released through the guarded machinery.
    const released = await ctx.escrow.releaseDeliveredEscrows(deadline);
    expect(released).toHaveLength(1);
    expect(released[0].status).toBe('released');
    expect((await ctx.escrow.escrowForOrder('order-buyer-cassava'))!.status).toBe('released');
    // The auto-release event was published to the outbox.
    const names = (await ctx.events.listOutbox()).map((event) => event.name);
    expect(names).toContain('marketplace.escrow.auto_released');
    // Re-running the sweep is a no-op (terminal state).
    expect(await ctx.escrow.releaseDeliveredEscrows(deadline)).toHaveLength(0);
  });

  it('the party-driven API cannot enter delivered_pending_confirm directly (attestation-only state)', async () => {
    const ctx = makeService();
    const record = await ctx.escrow.holdForOrder('order-buyer-cassava', buyer.id);
    await expect(
      ctx.escrow.transition(record.id, 'delivered_pending_confirm', buyer)
    ).rejects.toThrowError(/Invalid escrow transition/);
    await expect(
      ctx.escrow.transition(record.id, 'delivered_pending_confirm', admin)
    ).rejects.toThrowError(BadRequestException);
  });

  it('the buyer confirms early from delivered_pending_confirm; the seller cannot', async () => {
    const ctx = makeService();
    await heldGeoSealedEscrow(ctx, 1);
    const record = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    await ctx.service.attestDelivery(record.id, { ...DROP, deviceBasis: 'gps' }, buyer);
    await expect(ctx.escrow.transition(record.id, 'released', seller)).rejects.toThrowError(
      ForbiddenException
    );
    await ctx.escrow.transition(record.id, 'released', buyer);
    expect((await ctx.escrow.escrowForOrder('order-buyer-cassava'))!.status).toBe('released');
  });
});

describe('DeliveryAttestationService — concurrency and hash chain', () => {
  it('concurrent attest + admin refund race has exactly one winner', async () => {
    const ctx = makeService();
    await heldGeoSealedEscrow(ctx, 1);
    const record = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    const [attest, refund] = await Promise.allSettled([
      ctx.service.attestDelivery(record.id, { ...DROP, deviceBasis: 'gps' }, buyer),
      ctx.escrow.transition(record.id, 'refunded', admin)
    ]);
    const outcomes = [attest, refund];
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    // The loser hits the CAS guard (409) — never a silent overwrite.
    expect(loser.reason).toBeInstanceOf(ConflictException);
    const final = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    expect(['delivered_pending_confirm', 'refunded']).toContain(final.status);
    // Either way the attestation evidence row stands (append-only log).
    expect(await ctx.attestations.listByEscrow(record.id)).toHaveLength(1);
  });

  it('chains attestations (genesis → head) and verifies continuity; tampering breaks the chain', async () => {
    const ctx = makeService();
    await heldGeoSealedEscrow(ctx, 1);
    const record = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    // seq 0: out-of-geofence (recorded, rejected); seq 1: in-geofence.
    await expect(
      ctx.service.attestDelivery(record.id, { ...FAR, deviceBasis: 'gps' }, buyer)
    ).rejects.toThrowError(ConflictException);
    await ctx.service.attestDelivery(record.id, { ...DROP, deviceBasis: 'gps' }, buyer);
    const trail = await ctx.attestations.listByEscrow(record.id);
    expect(trail).toHaveLength(2);
    expect(trail[0].seq).toBe(0);
    expect(trail[0].prevHash).toBe(GENESIS_PREV_HASH);
    expect(trail[1].prevHash).toBe(trail[0].payloadHash);
    // Hashes recompute from the canonical payload.
    expect(trail[1].payloadHash).toBe(
      computeAttestationHash(attestationHashPayloadOf(trail[1]))
    );
    expect(verifyAttestationChain(trail)).toBe(-1);
    // Tamper with any recorded field and the chain reports the broken link.
    const tampered: DeliveryAttestation[] = [
      trail[0],
      { ...trail[1], withinGeofence: false }
    ];
    expect(verifyAttestationChain(tampered)).toBe(1);
    const forked: DeliveryAttestation[] = [trail[0], { ...trail[1], prevHash: trail[0].prevHash }];
    expect(verifyAttestationChain(forked)).toBe(1);
  });

  it('refuses a chain-extension collision (same escrow + seq) with 409', async () => {
    const attestations = new InMemoryDeliveryAttestationRepository();
    const ctx = makeService();
    await heldGeoSealedEscrow(ctx, 1);
    const record = (await ctx.escrow.escrowForOrder('order-buyer-cassava'))!;
    await ctx.service.attestDelivery(record.id, { ...DROP, deviceBasis: 'gps' }, buyer);
    const [head] = await ctx.attestations.listByEscrow(record.id);
    // Re-appending the same (escrow, seq) or same payload_hash conflicts —
    // a rewritten history cannot silently extend the stored chain.
    await expect(attestations.append(head)).resolves.toBeDefined(); // fresh store accepts
    await expect(attestations.append({ ...head, id: 'dlat-fork' })).rejects.toThrowError(
      ConflictException
    );
    await expect(ctx.attestations.append(head)).rejects.toThrowError(ConflictException);
  });
});

describe('migration 067 — pg contract', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(
    join(here, '..', '..', '..', '..', '..', 'infra', 'postgres', '067_escrow_delivery_geo.sql'),
    'utf8'
  );

  it('creates the append-only hash-chained marketplace.delivery_attestations table', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS marketplace.delivery_attestations');
    expect(migration).toContain('REFERENCES marketplace.escrow_records(id)');
    expect(migration).toContain('UNIQUE (escrow_id, seq)');
    // 64-char lowercase-hex chain columns (genesis = 64 zeroes).
    expect(migration).toContain("prev_hash        text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$')");
    expect(migration).toContain('payload_hash     text NOT NULL UNIQUE');
    // Role + device-basis vocabularies are DB-enforced.
    expect(migration).toContain("CHECK (role IN ('buyer','agent'))");
    expect(migration).toContain("CHECK (device_basis IN ('gps','network','manual'))");
    // No database triggers (repo convention); append-only is structural.
    expect(migration.toUpperCase()).not.toContain('CREATE TRIGGER');
  });

  it('extends escrow_records with opt-in geo columns and CHECK bounds', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS delivery_point_h3 text');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS geofence_radius_cells integer');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS delivery_confirm_until timestamptz');
    // Radius bounds mirror H3Service.MAX_GEO_RING (0..10 cells).
    expect(migration).toContain(
      'CHECK (geofence_radius_cells IS NULL OR geofence_radius_cells BETWEEN 0 AND 10)'
    );
    // The status CHECK admits the new state and keeps every existing one.
    expect(migration).toContain(
      "CHECK (status IN ('held','releasing','released','refunding','refunded','disputed','delivered_pending_confirm'))"
    );
  });

  it('keeps the geo-sealed-delivery rollout flag default OFF', () => {
    expect(migration).toContain("'geo-sealed-delivery'");
    expect(migration).toContain('ON CONFLICT (key) DO NOTHING');
    // The seeded row is enabled=false (default OFF).
    const flagRow = migration.split('geo-sealed-delivery')[1];
    expect(flagRow.slice(0, flagRow.indexOf('0,'))).toContain('false');
  });
});
