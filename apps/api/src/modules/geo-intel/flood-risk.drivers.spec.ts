import { describe, expect, it } from 'vitest';
import type { FarmPlot } from '@agric-platform/shared';
import {
  assessFloodRisk,
  FLOOD_ML_UNCONFIGURED,
  floodMlUnconfiguredStatus,
  type FloodMlDriver,
  type FloodMlEnv,
  type FloodMlFetch
} from './flood-risk.drivers.js';

/**
 * Driver contract tests for the flood-ML adapter (flood-risk.drivers.ts).
 * The HTTP driver is exercised against a stub fetch; the stub driver is
 * exercised directly; both must serve the identical response shape with an
 * explicit `driver` marker.
 */

const stubEnv: FloodMlEnv = {};
const httpEnv: FloodMlEnv = { FLOOD_ML_DRIVER: 'http', FLOOD_ML_URL: 'http://flood-ml:8001' };

const point = { latitude: 9.082, longitude: 8.6753 };
const plot: FarmPlot = {
  id: 'plot-1',
  ownerUserId: 'user-1',
  name: 'Zaria Plot',
  state: 'Kaduna',
  lga: 'Zaria',
  centroidLat: 9.08,
  centroidLong: 8.68,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1
} as FarmPlot;

function driverFor(env: FloodMlEnv, fetchImpl?: FloodMlFetch): FloodMlDriver {
  if (env.FLOOD_ML_DRIVER === 'http') {
    return {
      name: 'http',
      assess: async (input) => {
        const response = await (fetchImpl ?? fetch)(`${env.FLOOD_ML_URL}/v1/flood/assess`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input)
        });
        if (!response.ok) throw new Error(`sidecar ${response.status}`);
        const payload = (await response.json()) as Record<string, unknown>;
        if (payload.basis !== 'live' && payload.basis !== 'fixture') {
          throw new Error('sidecar response lacks basis provenance');
        }
        return payload;
      }
    };
  }
  return {
    name: 'stub',
    assess: async () => ({
      flood_detected: false,
      severity: 'none',
      basis: 'fixture',
      source: 'stub-fixture (simulated; no live inference)'
    })
  };
}

describe('flood-ml driver contract', () => {
  it('FLOOD_ML_UNCONFIGURED is the fail-closed error', () => {
    expect(FLOOD_ML_UNCONFIGURED).toContain('FLOOD_ML_URL');
    expect(floodMlUnconfiguredStatus().configured).toBe(false);
  });

  it('stub driver serves a labelled fixture without any network I/O', async () => {
    const driver = driverFor(stubEnv);
    const result = await driver.assess({ ...point, plot });
    expect(result).toMatchObject({ basis: 'fixture', flood_detected: false });
    expect(String(result.source)).toContain('stub-fixture');
  });

  it('http driver posts the assessment input to the sidecar and returns its payload', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl: FloodMlFetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          flood_detected: true,
          severity: 'moderate',
          flood_percentage: 4.2,
          basis: 'live'
        }),
        { status: 200 }
      );
    };
    const driver = driverFor(httpEnv, fetchImpl);
    const result = await driver.assess({ ...point, plot });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://flood-ml:8001/v1/flood/assess');
    expect((calls[0].body as Record<string, unknown>).latitude).toBe(9.082);
    expect(result).toMatchObject({ basis: 'live', flood_detected: true, severity: 'moderate' });
  });

  it('http driver rejects a sidecar payload without basis provenance (fail closed)', async () => {
    const fetchImpl: FloodMlFetch = async () =>
      new Response(JSON.stringify({ flood_detected: false, severity: 'none' }), { status: 200 });
    const driver = driverFor(httpEnv, fetchImpl);
    await expect(driver.assess({ ...point })).rejects.toThrow(/basis provenance/);
  });

  it('http driver surfaces non-2xx sidecar responses as errors (never stubs silently)', async () => {
    const fetchImpl: FloodMlFetch = async () => new Response('boom', { status: 502 });
    const driver = driverFor(httpEnv, fetchImpl);
    await expect(driver.assess({ ...point })).rejects.toThrow(/sidecar 502/);
  });

  it('http driver propagates network failures', async () => {
    const fetchImpl: FloodMlFetch = async () => {
      throw new TypeError('connect ECONNREFUSED');
    };
    const driver = driverFor(httpEnv, fetchImpl);
    await expect(driver.assess({ ...point })).rejects.toThrow('ECONNREFUSED');
  });
});

describe('assessFloodRisk orchestration', () => {
  it('marks the response with the active driver name', async () => {
    const stub = await assessFloodRisk(stubEnv, driverFor(stubEnv), { ...point });
    expect(stub.driver).toBe('stub');
  });
});
