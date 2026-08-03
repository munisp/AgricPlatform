import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '../../core/domain-events.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { AuditService } from '../../core/audit.service.js';
import type { FarmPlot, Profile, User } from '@agric-platform/shared';
import { createInMemoryAuditRepository } from '../../database/repositories/audit.repository.js';
import { createInMemoryFarmPlotRepository } from '../../database/repositories/farms.repository.js';
import {
  createInMemoryGeoBoundaryRepository,
  createInMemoryH3IndexRepository
} from '../../database/repositories/geo.repository.js';
import { InMemoryProfileRepository } from '../../database/repositories/profile.repository.js';
import { GeoService } from './geo.service.js';
import { H3Service } from './h3.service.js';

/* ------------------------------- fixtures ------------------------------- */

const admin: User = {
  id: 'user-geo-admin',
  phone: '+2348070000100',
  fullName: 'Geo Admin',
  roles: ['admin'],
  preferredLanguage: 'en',
  kycTier: 'tier_3',
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const partner: User = { ...admin, id: 'user-geo-partner', roles: ['partner'] };
const chapterLead: User = { ...admin, id: 'user-geo-lead', roles: ['chapter_lead'] };
const farmerOne: User = { ...admin, id: 'user-geo-farmer-1', roles: ['farmer'] };
const farmerTwo: User = { ...admin, id: 'user-geo-farmer-2', roles: ['farmer'] };

function plot(id: string, ownerUserId: string, lat: number, long: number): FarmPlot {
  return {
    id,
    ownerUserId,
    name: `Plot ${id}`,
    state: 'Kaduna',
    lga: 'Zaria',
    centroidLat: lat,
    centroidLong: long,
    sizeHectares: 1.5,
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    version: 1
  };
}

// Ground truth (h3-js 4.5.0): Zaria 11.0855/7.7199 → 85581b97fffffff /
// 87581b966ffffff / 89581b96683ffff; Kano 12.0022/8.592 → 85580a47fffffff.
const ZARIA = { lat: 11.0855, long: 7.7199 };
const ZARIA_RES5 = '85581b97fffffff';
const ZARIA_RES7 = '87581b966ffffff';

const zariaPlot = plot('plot-zaria', farmerOne.id, ZARIA.lat, ZARIA.long);
const kanoPlot = plot('plot-kano', farmerTwo.id, 12.0022, 8.592);
const lagosPlot = plot('plot-lagos', farmerOne.id, 6.5244, 3.3792);

const locatedProfile: Profile = {
  userId: farmerTwo.id,
  location: { state: 'Kano', lga: 'Kano Municipal', latitude: 12.0022, longitude: 8.592 },
  farmingInterests: ['maize'],
  valueChains: [],
  completionScore: 40,
  badges: []
};

const unlocatedProfile: Profile = {
  userId: farmerOne.id,
  location: { state: 'Kaduna', lga: 'Zaria' },
  farmingInterests: [],
  valueChains: [],
  completionScore: 10,
  badges: []
};

/** Simple square boundary around Zaria (GeoJSON [long, lat] order). */
const ZARIA_SQUARE = {
  type: 'Polygon',
  coordinates: [
    [
      [7.0, 10.5],
      [8.4, 10.5],
      [8.4, 11.6],
      [7.0, 11.6],
      [7.0, 10.5]
    ]
  ]
};

/* -------------------------------- setup --------------------------------- */

function makeService(seedPlots: FarmPlot[] = [zariaPlot, kanoPlot, lagosPlot]) {
  const audits = createInMemoryAuditRepository();
  const audit = new AuditService(audits);
  const listeners = new Map<string, (event: DomainEvent) => void>();
  const publish = vi.fn(
    async (name: string, payload: unknown, actorId?: string): Promise<DomainEvent> => ({
      id: 'event-stub',
      name,
      payload,
      actorId,
      occurredAt: '2026-03-01T00:00:00.000Z'
    })
  );
  const events = {
    publish,
    on: (name: string, handler: (event: DomainEvent) => void) => listeners.set(name, handler)
  } as unknown as DomainEventsService;
  const h3 = new H3Service();
  const h3Index = createInMemoryH3IndexRepository();
  const boundaries = createInMemoryGeoBoundaryRepository();
  const plots = createInMemoryFarmPlotRepository(seedPlots);
  const profiles = new InMemoryProfileRepository([locatedProfile, unlocatedProfile]);
  const service = new GeoService(audit, events, h3, h3Index, boundaries, plots, profiles);
  return { service, audit, publish, listeners, h3, h3Index, boundaries, plots, profiles };
}

/* -------------------------------- tests --------------------------------- */

describe('GeoService reindex', () => {
  it('indexes farm plots with the correct known H3 cells', async () => {
    const { service, h3Index } = makeService();
    const result = await service.reindex(admin);
    const farmReport = result.reports.find((report) => report.entity === 'farm_plot')!;
    expect(farmReport).toEqual({ entity: 'farm_plot', scanned: 3, indexed: 3, skipped: 0 });
    const [entry] = await h3Index.find({ entity: 'farm_plot', entityId: 'plot-zaria' });
    expect(entry.h3Res5).toBe(ZARIA_RES5);
    expect(entry.h3Res7).toBe(ZARIA_RES7);
    expect(entry.h3Res9).toBe('89581b96683ffff');
    expect(entry.lat).toBe(ZARIA.lat);
    expect(entry.long).toBe(ZARIA.long);
  });

  it('indexes located profiles and skips profiles without coordinates', async () => {
    const { service, h3Index } = makeService();
    const result = await service.reindex(admin);
    const profileReport = result.reports.find((report) => report.entity === 'profile')!;
    expect(profileReport).toEqual({ entity: 'profile', scanned: 2, indexed: 1, skipped: 1 });
    const [entry] = await h3Index.find({ entity: 'profile', entityId: farmerTwo.id });
    expect(entry.h3Res5).toBe('85580a47fffffff');
  });

  it('is idempotent: a second run rewrites the same rows and reports', async () => {
    const { service, h3Index } = makeService();
    const first = await service.reindex(admin);
    const countAfterFirst = await h3Index.count({});
    const second = await service.reindex(admin);
    expect(await h3Index.count({})).toBe(countAfterFirst);
    expect(second).toEqual(first);
  });

  it('is admin-only and audit-logged', async () => {
    const { service, audit } = makeService();
    await expect(service.reindex(farmerOne)).rejects.toThrow(ForbiddenException);
    await expect(service.reindex(null)).rejects.toThrow(UnauthorizedException);
    await service.reindex(admin);
    const entries = (await audit.list({ actorId: admin.id })).filter(
      (entry) => entry.action === 'geo.reindex'
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].entityType).toBe('h3_index');
  });
});

describe('GeoService event-driven indexing', () => {
  it('auto-indexes a plot on farms.plot.created without touching farms code', async () => {
    const { service, listeners, plots, h3Index, publish } = makeService([]);
    service.onModuleInit();
    await plots.create(zariaPlot);
    listeners.get('farms.plot.created')!({
      id: 'e1',
      name: 'farms.plot.created',
      payload: { plotId: zariaPlot.id },
      occurredAt: '2026-03-01T00:00:00.000Z'
    });
    await new Promise((resolve) => setImmediate(resolve));
    const [entry] = await h3Index.find({ entity: 'farm_plot', entityId: zariaPlot.id });
    expect(entry.h3Res7).toBe(ZARIA_RES7);
    expect(publish).toHaveBeenCalledWith(
      'geo.h3_index.updated',
      expect.objectContaining({ entity: 'farm_plot', entityId: zariaPlot.id }),
      undefined
    );
  });

  it('re-indexes on farms.plot.updated when the centroid moves', async () => {
    const { service, listeners, plots, h3Index } = makeService([zariaPlot]);
    service.onModuleInit();
    await service.reindex(admin);
    await plots.update(zariaPlot.id, { centroidLat: 12.0022, centroidLong: 8.592 });
    listeners.get('farms.plot.updated')!({
      id: 'e2',
      name: 'farms.plot.updated',
      payload: { plotId: zariaPlot.id },
      occurredAt: '2026-03-01T00:01:00.000Z'
    });
    await new Promise((resolve) => setImmediate(resolve));
    const [entry] = await h3Index.find({ entity: 'farm_plot', entityId: zariaPlot.id });
    expect(entry.h3Res5).toBe('85580a47fffffff'); // Kano cells now
  });

  it('de-indexes on farms.plot.removed', async () => {
    const { service, listeners, h3Index } = makeService([zariaPlot]);
    service.onModuleInit();
    await service.reindex(admin);
    expect(await h3Index.count({ entity: 'farm_plot', entityId: zariaPlot.id })).toBe(1);
    listeners.get('farms.plot.removed')!({
      id: 'e3',
      name: 'farms.plot.removed',
      payload: { plotId: zariaPlot.id },
      occurredAt: '2026-03-01T00:02:00.000Z'
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await h3Index.count({ entity: 'farm_plot', entityId: zariaPlot.id })).toBe(0);
  });
});

describe('GeoService farmsNear', () => {
  it('ring 0 returns only same-cell plots; ring 1 picks up neighbours', async () => {
    const { service, plots, h3 } = makeService();
    // A plot at the centre of a res-7 neighbour cell of the Zaria plot.
    const neighbour = h3.disk(ZARIA_RES7, 1).find((cell) => cell !== ZARIA_RES7)!;
    const [nearLat, nearLong] = h3.center(neighbour);
    await plots.create(plot('plot-near', farmerTwo.id, nearLat, nearLong));
    await service.reindex(admin);

    const ring0 = await service.farmsNear(partner, { ...ZARIA, res: 7, ring: 0 });
    expect(ring0.centerCell).toBe(ZARIA_RES7);
    expect(ring0.plots.map((p) => p.id)).toEqual(['plot-zaria']);

    const ring1 = await service.farmsNear(partner, { ...ZARIA, res: 7, ring: 1 });
    expect(ring1.plots.map((p) => p.id)).toEqual(['plot-near', 'plot-zaria']);
  });

  it('scopes results: farmers only ever see their own plots, managers see all', async () => {
    const { service } = makeService();
    await service.reindex(admin);
    // Kano plot belongs to farmerTwo; farmerOne queries next to it.
    const own = await service.farmsNear(farmerOne, { lat: 12.0022, long: 8.592, res: 7, ring: 1 });
    expect(own.plots).toEqual([]);
    const managed = await service.farmsNear(chapterLead, {
      lat: 12.0022,
      long: 8.592,
      res: 7,
      ring: 1
    });
    expect(managed.plots.map((p) => p.id)).toEqual(['plot-kano']);
  });

  it('validates coordinates, resolution and ring fail-closed', async () => {
    const { service } = makeService();
    await expect(service.farmsNear(admin, { lat: 95, long: 8 })).rejects.toThrow(
      BadRequestException
    );
    await expect(service.farmsNear(admin, { lat: 11, long: 8, res: 6 })).rejects.toThrow(
      BadRequestException
    );
    await expect(service.farmsNear(admin, { lat: 11, long: 8, ring: 99 })).rejects.toThrow(
      BadRequestException
    );
    await expect(service.farmsNear(null, { lat: 11, long: 8 })).rejects.toThrow(
      UnauthorizedException
    );
  });
});

describe('GeoService farmClusters', () => {
  it('aggregates indexed farms per cell at the requested resolution', async () => {
    const { service, plots, h3 } = makeService();
    const neighbour = h3.disk(ZARIA_RES7, 1).find((cell) => cell !== ZARIA_RES7)!;
    const [nearLat, nearLong] = h3.center(neighbour);
    await plots.create(plot('plot-near', farmerTwo.id, nearLat, nearLong));
    await service.reindex(admin);

    const clusters = await service.farmClusters(admin, 5);
    expect(clusters.entity).toBe('farm_plot');
    expect(clusters.resolution).toBe(5);
    expect(clusters.total).toBe(4);
    // The res-7 neighbour usually shares the res-5 parent, but near a parent
    // edge it may not — compute the expectation from ground truth either way.
    const nearRes5 = h3.cellAt(nearLat, nearLong, 5);
    const sharedParent = nearRes5 === ZARIA_RES5;
    expect(clusters.cells.find((cell) => cell.cell === ZARIA_RES5)?.count).toBe(
      sharedParent ? 2 : 1
    );
    expect(clusters.cells.find((cell) => cell.cell === nearRes5)?.count).toBe(
      sharedParent ? 2 : 1
    );
    expect(clusters.cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(4);
    // Sorted by count desc.
    expect(clusters.cells[0].count).toBeGreaterThanOrEqual(clusters.cells[1]?.count ?? 0);
  });

  it('is restricted to manager roles', async () => {
    const { service } = makeService();
    await expect(service.farmClusters(farmerOne)).rejects.toThrow(ForbiddenException);
    await expect(service.farmClusters(null)).rejects.toThrow(UnauthorizedException);
    await expect(service.farmClusters(partner)).resolves.toMatchObject({ entity: 'farm_plot' });
    await expect(service.farmClusters(chapterLead)).resolves.toMatchObject({
      entity: 'farm_plot'
    });
  });
});

describe('GeoService cellBoundary', () => {
  it('returns a closed GeoJSON polygon for a valid cell', () => {
    const { service } = makeService();
    const result = service.cellBoundary(farmerOne, ZARIA_RES7);
    expect(result.cell).toBe(ZARIA_RES7);
    expect(result.resolution).toBe(7);
    const ring = result.boundary.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('rejects invalid cells and anonymous callers', () => {
    const { service } = makeService();
    expect(() => service.cellBoundary(admin, 'nope')).toThrow(BadRequestException);
    expect(() => service.cellBoundary(null, ZARIA_RES7)).toThrow(UnauthorizedException);
  });
});

describe('GeoService boundaries', () => {
  it('admin creates boundaries; parent must exist; lists filter by kind', async () => {
    const { service } = makeService();
    const state = await service.createBoundary(admin, {
      kind: 'state',
      name: 'Kaduna',
      boundaryGeojson: ZARIA_SQUARE
    });
    expect(state.id).toMatch(/^geob-/);
    const lga = await service.createBoundary(admin, {
      kind: 'lga',
      name: 'Zaria',
      parentId: state.id,
      boundaryGeojson: ZARIA_SQUARE
    });
    expect(lga.parentId).toBe(state.id);
    await expect(
      service.createBoundary(admin, {
        kind: 'ward',
        name: 'Ghost',
        parentId: 'geob-missing',
        boundaryGeojson: ZARIA_SQUARE
      })
    ).rejects.toThrow(NotFoundException);
    expect(await service.listBoundaries(farmerOne, 'lga')).toHaveLength(1);
    expect(await service.listBoundaries(farmerOne)).toHaveLength(2);
  });

  it('rejects non-admins, empty names and malformed geometry', async () => {
    const { service } = makeService();
    await expect(
      service.createBoundary(partner, { kind: 'custom', name: 'X', boundaryGeojson: ZARIA_SQUARE })
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.createBoundary(admin, { kind: 'custom', name: ' ', boundaryGeojson: ZARIA_SQUARE })
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.createBoundary(admin, { kind: 'custom', name: 'X', boundaryGeojson: { nope: 1 } })
    ).rejects.toThrow(BadRequestException);
  });
});

describe('GeoService contains (point-in-boundary)', () => {
  it('checks inline GeoJSON: inside, outside and on-edge', async () => {
    const { service } = makeService();
    await expect(
      service.contains(farmerOne, { lat: 11.08, long: 7.7, geojson: ZARIA_SQUARE })
    ).resolves.toEqual({ contains: true });
    await expect(
      service.contains(farmerOne, { lat: 6.5, long: 3.4, geojson: ZARIA_SQUARE })
    ).resolves.toEqual({ contains: false });
    // Exactly on the southern edge — documented as inside.
    await expect(
      service.contains(farmerOne, { lat: 10.5, long: 7.7, geojson: ZARIA_SQUARE })
    ).resolves.toEqual({ contains: true });
  });

  it('checks a stored boundary by id', async () => {
    const { service } = makeService();
    const boundary = await service.createBoundary(admin, {
      kind: 'state',
      name: 'Kaduna',
      boundaryGeojson: ZARIA_SQUARE
    });
    await expect(
      service.contains(admin, { lat: 11.08, long: 7.7, boundaryId: boundary.id })
    ).resolves.toEqual({ contains: true });
    await expect(
      service.contains(admin, { lat: 12.5, long: 8.6, boundaryId: boundary.id })
    ).resolves.toEqual({ contains: false });
    await expect(
      service.contains(admin, { lat: 11, long: 7.7, boundaryId: 'geob-missing' })
    ).rejects.toThrow(NotFoundException);
  });

  it('requires exactly one of boundaryId or geojson and valid coordinates', async () => {
    const { service } = makeService();
    await expect(service.contains(admin, { lat: 11, long: 7.7 })).rejects.toThrow(
      BadRequestException
    );
    await expect(
      service.contains(admin, { lat: 11, long: 7.7, boundaryId: 'x', geojson: ZARIA_SQUARE })
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.contains(admin, { lat: 200, long: 7.7, geojson: ZARIA_SQUARE })
    ).rejects.toThrow(BadRequestException);
    await expect(service.contains(null, { lat: 11, long: 7.7, geojson: ZARIA_SQUARE })).rejects.toThrow(
      UnauthorizedException
    );
  });
});
