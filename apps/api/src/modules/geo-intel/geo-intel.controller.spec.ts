import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import type { GeoIntelService } from './geo-intel.service.js';
import { GeoIntelController } from './geo-intel.controller.js';

const actor = { id: 'user-1', roles: ['farmer'] } as User;

function makeController() {
  const service = {
    assessFloodRisk: vi.fn().mockImplementation(async (user: User | null) => {
      if (!user) {
        throw new UnauthorizedException('Authentication required for geo-intel assessments');
      }
      return { driver: 'stub' };
    }),
    floodRiskStatus: vi.fn().mockImplementation(async (user: User | null) => {
      if (!user) {
        throw new UnauthorizedException('Authentication required for geo-intel assessments');
      }
      return { driver: 'stub', configured: true, healthy: true, liveInference: false };
    })
  } as unknown as GeoIntelService;
  return { controller: new GeoIntelController(service), service };
}

describe('GeoIntelController', () => {
  it('rejects anonymous callers on both endpoints (401)', async () => {
    const { controller } = makeController();
    await expect(controller.floodRisk(null, '9.08', '8.68')).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    await expect(controller.floodRiskStatus(null)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects non-numeric coordinates with 400 before hitting the service', async () => {
    const { controller, service } = makeController();
    await expect(controller.floodRisk(actor, 'abc', '8.68')).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(service.assessFloodRisk).not.toHaveBeenCalled();
  });

  it('parses numeric query strings and delegates to the service', async () => {
    const { controller, service } = makeController();
    const result = await controller.floodRisk(actor, '9.082', '8.6753');
    expect(service.assessFloodRisk).toHaveBeenCalledWith(actor, { lat: 9.082, long: 8.6753 });
    expect(result.data).toEqual({ driver: 'stub' });
  });

  it('passes undefined coordinates through when not provided', async () => {
    const { controller, service } = makeController();
    await controller.floodRisk(actor, undefined, undefined);
    expect(service.assessFloodRisk).toHaveBeenCalledWith(actor, { lat: undefined, long: undefined });
  });

  it('returns the honest status payload', async () => {
    const { controller } = makeController();
    const result = await controller.floodRiskStatus(actor);
    expect(result.data).toMatchObject({ driver: 'stub', liveInference: false });
  });
});
