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

/**
 * Realistic crop-ml sidecar payload — mirrors the shipped schemas in
 * services/crop-ml/app/models.py (AssessPlotResponse): score at
 * health.score, structured HealthDriver objects, phenology under
 * seasonality, provenance via the top-level `provider` field.
 */
const LIVE_ASSESSMENT = {
  plot_id: 'plot-1',
  season: '2026-wet',
  provider: 'live',
  seasonality: {
    plot_id: 'plot-1',
    acquisitions: 12,
    ndvi: [
      { date: '2026-04-10', ndvi: 0.42 },
      { date: '2026-06-15', ndvi: 0.83 }
    ],
    phenology: {
      sos_date: '2026-04-10',
      eos_date: '2026-09-01',
      peak_date: '2026-06-15',
      peak_value: 0.83,
      base_value: 0.21,
      amplitude: 0.62,
      season_length_days: 144
    },
    mean_ndvi: 0.58,
    reference_phenology: null,
    classification: { label: 'normal', reason_codes: ['within_baseline'] }
  },
  health: {
    plot_id: 'plot-1',
    score: 72.4,
    drivers: [
      { code: 'ndvi_deficit', impact: 12.6, detail: 'mean NDVI below seasonal baseline' },
      { code: 'late_sos', impact: 8, detail: 'season start later than baseline' }
    ],
    current_phenology: {
      sos_date: '2026-04-10',
      eos_date: '2026-09-01',
      peak_date: '2026-06-15',
      peak_value: 0.83,
      base_value: 0.21,
      amplitude: 0.62,
      season_length_days: 144
    },
    baseline_phenology: {
      sos_date: '2026-04-01',
      eos_date: '2026-09-05',
      peak_date: '2026-06-10',
      peak_value: 0.9,
      base_value: 0.2,
      amplitude: 0.7,
      season_length_days: 157
    }
  }
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
  it('maps the real sidecar response (GAP-C01: no degradation to 0/stressed/stub)', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse(LIVE_ASSESSMENT));
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpCropIntelClient('http://crop-ml:8100');
    const assessment = await client.assessPlot({ plotId: 'plot-1', season: '2026-wet' });
    // health.score is used — not a fabricated 0.
    expect(assessment.healthScore).toBe(72);
    // Provenance comes from the sidecar's own provider field — never a
    // false 'stub' label on a live response.
    expect(assessment.basis).toBe('live');
    // seasonality.classification.label is used — not a fallback 'stressed'.
    expect(assessment.classification).toBe('normal');
    // seasonality.phenology maps sos/eos/peak.
    expect(assessment.phenology).toEqual({
      sos: '2026-04-10',
      eos: '2026-09-01',
      peak: { date: '2026-06-15', value: 0.83 }
    });
    // Structured health drivers keep code, impact and detail.
    expect(assessment.drivers).toEqual([
      'ndvi_deficit (-12.6): mean NDVI below seasonal baseline',
      'late_sos (-8): season start later than baseline'
    ]);
    expect(assessment.season).toBe('2026-wet');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://crop-ml:8100/v1/crop/assess-plot');
    expect(JSON.parse(String(init?.body))).toEqual({ plot_id: 'plot-1', season: '2026-wet' });
  });

  it('honestly labels a response from the sidecar stub provider as basis stub', async () => {
    const stubSidecarResponse = {
      ...LIVE_ASSESSMENT,
      provider: 'stub'
    };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => jsonResponse(stubSidecarResponse)));
    const client = new HttpCropIntelClient('http://crop-ml:8100');
    const assessment = await client.assessPlot({ plotId: 'plot-1', season: '2026-wet' });
    expect(assessment.basis).toBe('stub');
    expect(assessment.healthScore).toBe(72);
  });

  it('fails closed when health.score is missing instead of persisting a fabricated 0', async () => {
    const malformed = { plot_id: 'plot-1', season: '2026-wet', provider: 'live' };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => jsonResponse(malformed)));
    const client = new HttpCropIntelClient('http://crop-ml:8100');
    await expect(client.assessPlot({ plotId: 'plot-1' })).rejects.toThrow(ProviderRequestError);
  });

  it('fails closed on an unknown provider provenance label', async () => {
    const unknownProvenance = { ...LIVE_ASSESSMENT, provider: 'sentinel-hub' };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => jsonResponse(unknownProvenance)));
    const client = new HttpCropIntelClient('http://crop-ml:8100');
    await expect(client.assessPlot({ plotId: 'plot-1' })).rejects.toThrow(ProviderRequestError);
  });

  it('falls back to the score-derived band when the classification label is unknown', async () => {
    const weirdLabel = {
      ...LIVE_ASSESSMENT,
      seasonality: {
        ...LIVE_ASSESSMENT.seasonality,
        classification: { label: 'unexpected', reason_codes: [] }
      }
    };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => jsonResponse(weirdLabel)));
    const client = new HttpCropIntelClient('http://crop-ml:8100');
    const assessment = await client.assessPlot({ plotId: 'plot-1' });
    // healthScore 72 → derived band 'normal' (>= 67).
    expect(assessment.classification).toBe('normal');
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
