import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FarmPlot, User } from '@agric-platform/shared';
import type { AuditService } from '../../core/audit.service.js';
import type { DomainEventsService } from '../../core/domain-events.service.js';
import type { FarmsService } from '../farms/farms.service.js';
import { distanceKm, GeoIntelService } from './geo-intel.service.js';

const actor = { id: 'user-1', roles: ['farmer'] } as User;

const plot = (overrides: Partial<FarmPlot> = {}): FarmPlot =>
  ({
    id: 'plot-1',
    ownerUserId: 'user-1',
    name: 'Zaria North Plot',
    state: 'Kaduna',
    lga: 'Zaria',
    centroidLat: 11.0855,
    centroidLong: 7.7199,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides
  }) as FarmPlot;

function makeService(plots: FarmPlot[] = []) {
  const audit = { record: vi.fn().mockResolvedValue({}) } as unknown as AuditService;
  const events = { publish: vi.fn().mockResolvedValue({}) } as unknown as DomainEventsService;
  const farms = {
    listPlots: vi.fn().mockResolvedValue(plots)
  } as unknown as FarmsService;
  const service = new GeoIntelService(audit, events, farms);
  return { service, audit, events, farms };
}

describe('distanceKm', () => {
  it('computes haversine distance (Zaria → Abuja ≈ 230 km)', () => {
    expect(distanceKm(11.0855, 7.7199, 9.0765, 7.3986)).toBeGreaterThan(200);
    expect(distanceKm(11.0855, 7.7199, 9.0765, 7.3986)).toBeLessThan(260);
    expect(distanceKm(9.08, 8.68, 9.08, 8.68)).toBe(0);
  });
});

describe('GeoIntelService.assessFloodRisk', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.FLOOD_ML_DRIVER;
    delete process.env.FLOOD_ML_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects anonymous callers with 401', async () => {
    const { service } = makeService();
    await expect(service.assessFloodRisk(null, { lat: 9, long: 8 })).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    await expect(service.floodRiskStatus(null)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('requires lat and long together and validates ranges', async () => {
    const { service } = makeService();
    await expect(service.assessFloodRisk(actor, { lat: 9 })).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(service.assessFloodRisk(actor, { lat: 95, long: 8 })).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(service.assessFloodRisk(actor, { lat: 9, long: 200 })).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('assesses an explicit point with the stub driver and records audit + domain event', async () => {
    const { service, audit, events } = makeService();
    const result = await service.assessFloodRisk(actor, { lat: 9.082, long: 8.6753 });
    expect(result.driver).toBe('stub');
    expect(result.assessedLocation).toEqual({ latitude: 9.082, longitude: 8.6753 });
    expect(result.source).toContain('stub-fixture');
    expect(result.plot).toBeUndefined();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        action: 'geo_intel.flood_risk_assessed',
        entityType: 'flood_risk_assessment'
      })
    );
    expect(events.publish).toHaveBeenCalledWith(
      'geo_intel.flood_risk.assessed',
      expect.objectContaining({ driver: 'stub', latitude: 9.082, longitude: 8.6753 }),
      'user-1'
    );
  });

  it('falls back to the caller’s own plot centroid when no coordinates are given', async () => {
    const { service, farms } = makeService([plot()]);
    const result = await service.assessFloodRisk(actor, {});
    expect(farms.listPlots).toHaveBeenCalledWith(actor, { ownerUserId: 'user-1' });
    expect(result.assessedLocation).toEqual({ latitude: 11.0855, longitude: 7.7199 });
    expect(result.plot).toEqual({ id: 'plot-1', name: 'Zaria North Plot', distanceKm: 0 });
  });

  it('400s when no coordinates are given and the caller has no geo-located plots', async () => {
    const { service } = makeService([plot({ centroidLat: undefined, centroidLong: undefined })]);
    await expect(service.assessFloodRisk(actor, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('attaches the nearest own plot within range for explicit coordinates', async () => {
    const near = plot({ id: 'plot-near', centroidLat: 9.0, centroidLong: 8.7 });
    const far = plot({ id: 'plot-far', centroidLat: 6.45, centroidLong: 3.39 });
    const { service } = makeService([far, near]);
    const result = await service.assessFloodRisk(actor, { lat: 9.01, long: 8.71 });
    expect(result.plot?.id).toBe('plot-near');
    expect(result.plot?.distanceKm).toBeGreaterThan(0);
    expect(result.plot?.distanceKm).toBeLessThan(5);
  });

  it('does not attach plots farther than 50 km from the assessed point', async () => {
    const { service } = makeService([plot({ centroidLat: 6.45, centroidLong: 3.39 })]);
    const result = await service.assessFloodRisk(actor, { lat: 11.08, long: 7.72 });
    expect(result.plot).toBeUndefined();
  });

  it('fails closed with 503 when FLOOD_ML_DRIVER=http but FLOOD_ML_URL is missing', async () => {
    process.env.FLOOD_ML_DRIVER = 'http';
    delete process.env.FLOOD_ML_URL;
    const { service } = makeService();
    await expect(service.assessFloodRisk(actor, { lat: 9, long: 8 })).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  it('fails closed with 503 when the sidecar is unreachable (never silently stubs)', async () => {
    process.env.FLOOD_ML_DRIVER = 'http';
    process.env.FLOOD_ML_URL = 'http://flood-ml:8001';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('connect ECONNREFUSED')));
    const { service } = makeService();
    await expect(service.assessFloodRisk(actor, { lat: 9, long: 8 })).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  it('serves live assessments from the sidecar when reachable', async () => {
    process.env.FLOOD_ML_DRIVER = 'http';
    process.env.FLOOD_ML_URL = 'http://flood-ml:8001';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            flood_detected: true,
            severity: 'high',
            flood_percentage: 12.4,
            flood_area_km2: 3.1,
            avg_confidence: 0.87
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );
    const { service } = makeService();
    const result = await service.assessFloodRisk(actor, { lat: 9.08, long: 8.68 });
    expect(result.driver).toBe('http');
    expect(result.floodDetected).toBe(true);
    expect(result.severity).toBe('high');
    expect(result.source).toContain('flood-ml sidecar');
  });
});

describe('GeoIntelService.floodRiskStatus', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.FLOOD_ML_DRIVER;
    delete process.env.FLOOD_ML_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('honestly reports the stub driver as simulated (liveInference false)', async () => {
    const { service } = makeService();
    const status = await service.floodRiskStatus(actor);
    expect(status).toMatchObject({
      driver: 'stub',
      configured: true,
      healthy: true,
      liveInference: false
    });
    expect(status.detail).toContain('Stub driver');
  });

  it('reports http-selected-but-unconfigured without throwing', async () => {
    process.env.FLOOD_ML_DRIVER = 'http';
    delete process.env.FLOOD_ML_URL;
    const { service } = makeService();
    const status = await service.floodRiskStatus(actor);
    expect(status).toMatchObject({
      driver: 'http',
      configured: false,
      healthy: false,
      liveInference: false
    });
    expect(status.detail).toContain('FLOOD_ML_URL is missing');
  });

  it('reports an unreachable sidecar as unhealthy', async () => {
    process.env.FLOOD_ML_DRIVER = 'http';
    process.env.FLOOD_ML_URL = 'http://flood-ml:8001';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('down')));
    const { service } = makeService();
    const status = await service.floodRiskStatus(actor);
    expect(status).toMatchObject({ driver: 'http', healthy: false, liveInference: false });
  });
});
