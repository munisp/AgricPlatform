import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigError, ProviderRequestError } from '../integrations/drivers/http.js';
import {
  createFloodRiskDriver,
  FLOOD_ML_CIRCUIT_THRESHOLD,
  HttpFloodRiskDriver,
  StubFloodRiskDriver
} from './flood-risk.drivers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('StubFloodRiskDriver', () => {
  const driver = new StubFloodRiskDriver();

  it('is deterministic: same coordinates always produce the same assessment', async () => {
    const a = await driver.assess({ latitude: 9.082, longitude: 8.6753 });
    const b = await driver.assess({ latitude: 9.082, longitude: 8.6753 });
    expect({ ...a, assessedAt: undefined }).toEqual({ ...b, assessedAt: undefined });
  });

  it('varies with coordinates but stays within the fixture range', async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 12; i += 1) {
      const result = await driver.assess({ latitude: 6.5 + i * 0.37, longitude: 3.3 + i * 0.53 });
      expect(result.floodPercentage).toBeGreaterThanOrEqual(0);
      expect(result.floodPercentage).toBeLessThanOrEqual(24);
      seen.add(result.floodPercentage);
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('labels every field as simulated so it can never pass as live verification', async () => {
    const result = await driver.assess({ latitude: 12.0, longitude: 8.5 });
    expect(result.source).toContain('stub-fixture');
    expect(result.source).toContain('not a live satellite assessment');
    expect(result.message).toMatch(/[Ss]imulated/);
  });

  it('keeps severity, detection and area consistent with the percentage', async () => {
    for (let i = 0; i < 25; i += 1) {
      const result = await driver.assess({ latitude: 4 + i * 0.41, longitude: 7 + i * 0.29 });
      expect(result.floodDetected).toBe(result.floodPercentage >= 1);
      const expectedSeverity =
        result.floodPercentage >= 20
          ? 'severe'
          : result.floodPercentage >= 10
            ? 'high'
            : result.floodPercentage >= 5
              ? 'moderate'
              : result.floodPercentage >= 1
                ? 'low'
                : 'none';
      expect(result.severity).toBe(expectedSeverity);
      expect(result.floodAreaKm2).toBeCloseTo(25 * (result.floodPercentage / 100), 1);
    }
  });

  it('reports an honest stub status', async () => {
    const status = await driver.status();
    expect(status).toMatchObject({ configured: true, healthy: true });
    expect(status.detail).toContain('Stub driver');
  });
});

describe('createFloodRiskDriver factory', () => {
  it('defaults to the stub driver when FLOOD_ML_DRIVER is unset', () => {
    expect(createFloodRiskDriver({})).toBeInstanceOf(StubFloodRiskDriver);
  });

  it('fails closed with ProviderConfigError when http is selected without FLOOD_ML_URL', () => {
    expect(() => createFloodRiskDriver({ FLOOD_ML_DRIVER: 'http' })).toThrow(ProviderConfigError);
  });

  it('builds the http driver when driver and URL are both set', () => {
    const driver = createFloodRiskDriver({
      FLOOD_ML_DRIVER: 'http',
      FLOOD_ML_URL: 'http://flood-ml:8001/'
    });
    expect(driver).toBeInstanceOf(HttpFloodRiskDriver);
    expect(driver.name).toBe('http');
  });
});

describe('HttpFloodRiskDriver', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

  it('posts to {FLOOD_ML_URL}/predict and maps the snake_case response', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({
        flood_detected: true,
        severity: 'moderate',
        flood_percentage: 7.5,
        flood_area_km2: 1.88,
        avg_confidence: 0.83,
        timestamp: '2026-01-01T00:00:00',
        message: 'Flooding likely',
        recommended_actions: ['Move livestock']
      })
    );
    const driver = new HttpFloodRiskDriver('http://flood-ml:8001');
    const result = await driver.assess({ latitude: 9.08, longitude: 8.68 });
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://flood-ml:8001/predict');
    expect(JSON.parse(init.body as string)).toEqual({ latitude: 9.08, longitude: 8.68 });
    expect(result).toMatchObject({
      floodDetected: true,
      severity: 'moderate',
      floodPercentage: 7.5,
      floodAreaKm2: 1.88,
      confidence: 0.83,
      message: 'Flooding likely',
      recommendedActions: ['Move livestock']
    });
    expect(result.source).toContain('flood-ml sidecar');
    expect(result.source).toContain('unverified');
  });

  it('surfaces network failures as ProviderRequestError', async () => {
    fetchMock().mockRejectedValue(new TypeError('connect ECONNREFUSED'));
    const driver = new HttpFloodRiskDriver('http://flood-ml:8001');
    await expect(driver.assess({ latitude: 1, longitude: 1 })).rejects.toBeInstanceOf(
      ProviderRequestError
    );
  });

  it('opens the circuit after consecutive failures and fails fast without fetching', async () => {
    fetchMock().mockRejectedValue(new TypeError('down'));
    const driver = new HttpFloodRiskDriver('http://flood-ml:8001');
    for (let i = 0; i < FLOOD_ML_CIRCUIT_THRESHOLD; i += 1) {
      await expect(driver.assess({ latitude: 1, longitude: 1 })).rejects.toBeInstanceOf(
        ProviderRequestError
      );
    }
    expect(driver.circuitOpen).toBe(true);
    const callsBefore = fetchMock().mock.calls.length;
    await expect(driver.assess({ latitude: 1, longitude: 1 })).rejects.toBeInstanceOf(
      ProviderRequestError
    );
    expect(fetchMock().mock.calls.length).toBe(callsBefore);
  });

  it('resets the failure counter after a success', async () => {
    const driver = new HttpFloodRiskDriver('http://flood-ml:8001');
    fetchMock()
      .mockRejectedValueOnce(new TypeError('down'))
      .mockResolvedValueOnce(jsonResponse({ flood_detected: false }));
    await expect(driver.assess({ latitude: 1, longitude: 1 })).rejects.toBeInstanceOf(
      ProviderRequestError
    );
    await expect(driver.assess({ latitude: 1, longitude: 1 })).resolves.toMatchObject({
      floodDetected: false
    });
    expect(driver.circuitOpen).toBe(false);
  });

  it('reports healthy with Sentinel Hub detail when /healthz answers', async () => {
    fetchMock().mockResolvedValue(jsonResponse({ status: 'healthy', sentinel_hub_configured: true }));
    const driver = new HttpFloodRiskDriver('http://flood-ml:8001');
    const status = await driver.status();
    expect(status).toMatchObject({ configured: true, healthy: true });
    expect(status.detail).toContain('Sentinel Hub credentials configured');
    expect((fetchMock().mock.calls[0] as [string])[0]).toBe('http://flood-ml:8001/healthz');
  });

  it('warns when the sidecar is up but Sentinel Hub is not configured', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ status: 'healthy', sentinel_hub_configured: false })
    );
    const status = await new HttpFloodRiskDriver('http://flood-ml:8001').status();
    expect(status.healthy).toBe(true);
    expect(status.detail).toContain('NOT configured');
  });

  it('reports unhealthy (not throwing) when the sidecar is unreachable', async () => {
    fetchMock().mockRejectedValue(new TypeError('connect ECONNREFUSED'));
    const status = await new HttpFloodRiskDriver('http://flood-ml:8001').status();
    expect(status).toMatchObject({ configured: true, healthy: false });
    expect(status.detail).toContain('unreachable');
  });
});
