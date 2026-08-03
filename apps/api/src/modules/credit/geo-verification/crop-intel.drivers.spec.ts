import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CROP_ML_CIRCUIT_THRESHOLD,
  CROP_ML_RETRIES,
  createCropIntelClient,
  HttpCropIntelClient,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  StubCropIntelClient
} from './crop-intel.drivers.js';

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

const LIVE_ASSESSMENT = {
  plot_id: 'plot-1',
  season: '2026-wet',
  health_score: 72.4,
  phenology: { sos: '2026-04-10', eos: '2026-09-01', peak: { date: '2026-06-15', value: 0.83 } },
  classification: 'normal',
  drivers: ['ndvi-trend'],
  basis: 'live'
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('StubCropIntelClient', () => {
  it('is deterministic per plot_id (hash-seeded)', async () => {
    const client = new StubCropIntelClient();
    const first = await client.assessPlot({ plotId: 'plot-zaria-1' });
    const second = await client.assessPlot({ plotId: 'plot-zaria-1' });
    expect(first).toEqual(second);
  });

  it('health_score stays within 0–100 and is honestly labelled stub', async () => {
    const client = new StubCropIntelClient();
    for (const plotId of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const assessment = await client.assessPlot({ plotId });
      expect(assessment.healthScore).toBeGreaterThanOrEqual(0);
      expect(assessment.healthScore).toBeLessThanOrEqual(100);
      expect(assessment.basis).toBe('stub');
      expect(assessment.drivers.join(' ')).toContain('simulated');
    }
  });

  it('classification follows the health bands', async () => {
    const client = new StubCropIntelClient();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const assessment = await client.assessPlot({ plotId: `plot-${i}` });
      if (assessment.healthScore >= 67) expect(assessment.classification).toBe('normal');
      else if (assessment.healthScore >= 34) expect(assessment.classification).toBe('delayed');
      else expect(assessment.classification).toBe('stressed');
      seen.add(assessment.classification);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('createCropIntelClient', () => {
  it('defaults to the stub client', () => {
    expect(createCropIntelClient({}).name).toBe('stub');
  });

  it('fails closed when http is selected without CROP_ML_URL', () => {
    expect(() => createCropIntelClient({ CROP_ML_DRIVER: 'http' })).toThrow(ProviderConfigError);
  });

  it('builds the http client when fully configured', () => {
    const client = createCropIntelClient({
      CROP_ML_DRIVER: 'http',
      CROP_ML_URL: 'http://localhost:8100/'
    });
    expect(client.name).toBe('http');
  });
});

describe('HttpCropIntelClient', () => {
  it('maps the fixed contract response and records live basis', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse(LIVE_ASSESSMENT));
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpCropIntelClient('http://crop-ml:8100');
    const assessment = await client.assessPlot({ plotId: 'plot-1', season: '2026-wet' });
    expect(assessment.healthScore).toBe(72);
    expect(assessment.basis).toBe('live');
    expect(assessment.classification).toBe('normal');
    expect(assessment.phenology.peak).toEqual({ date: '2026-06-15', value: 0.83 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://crop-ml:8100/v1/crop/assess-plot');
    expect(JSON.parse(String(init?.body))).toEqual({ plot_id: 'plot-1', season: '2026-wet' });
  });

  it('retries 5xx up to 2 retries then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse({ error: 'boom' }, 500))
      .mockImplementationOnce(() => jsonResponse({ error: 'boom' }, 502))
      .mockImplementation(() => jsonResponse(LIVE_ASSESSMENT));
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpCropIntelClient('http://crop-ml:8100');
    const assessment = await client.assessPlot({ plotId: 'plot-1' });
    expect(assessment.healthScore).toBe(72);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never retries 4xx contract violations', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ error: 'bad' }, 400));
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpCropIntelClient('http://crop-ml:8100');
    await expect(client.assessPlot({ plotId: 'plot-1' })).rejects.toThrow(ProviderHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after 1 + CROP_ML_RETRIES attempts on persistent network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpCropIntelClient('http://crop-ml:8100');
    await expect(client.assessPlot({ plotId: 'plot-1' })).rejects.toThrow(ProviderRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1 + CROP_ML_RETRIES);
  });

  it('opens the circuit after CROP_ML_CIRCUIT_THRESHOLD consecutive failures and fails fast', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpCropIntelClient('http://crop-ml:8100');
    for (let i = 0; i < CROP_ML_CIRCUIT_THRESHOLD; i += 1) {
      await expect(client.assessPlot({ plotId: 'plot-1' })).rejects.toThrow();
    }
    expect(client.circuitOpen).toBe(true);
    fetchMock.mockClear();
    await expect(client.assessPlot({ plotId: 'plot-1' })).rejects.toThrow(ProviderRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('status() reports healthy when /healthz answers and unhealthy otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => jsonResponse({ status: 'ok' })));
    const client = new HttpCropIntelClient('http://crop-ml:8100');
    expect((await client.status()).healthy).toBe(true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const status = await client.status();
    expect(status.healthy).toBe(false);
    expect(status.configured).toBe(true);
  });
});
