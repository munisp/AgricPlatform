import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigError, ProviderHttpError } from '../integrations/drivers/http.js';
import { createNdviProvider, isNdviProviderError, NDVI_PROVIDER_TOKEN } from './ndvi.provider.js';

const ENV_KEYS = ['CROP_ML_DRIVER', 'CROP_ML_URL'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
});

describe('NDVI provider port (crop-ml contract)', () => {
  it('exposes a DI token for the module wiring', () => {
    expect(typeof NDVI_PROVIDER_TOKEN).toBe('symbol');
  });

  it('defaults to the deterministic STUB provider (basis stub, clearly labelled)', async () => {
    const provider = createNdviProvider(process.env);
    expect(provider.name).toBe('stub');
    const assessment = await provider.assess({ plotId: 'plot-1', season: '2026-wet' });
    expect(assessment.basis).toBe('stub');
    expect(assessment.plotId).toBe('plot-1');
    expect(assessment.season).toBe('2026-wet');
    expect(assessment.healthScore).toBeGreaterThanOrEqual(0);
    expect(assessment.healthScore).toBeLessThanOrEqual(100);
    expect(['normal', 'delayed', 'stressed']).toContain(assessment.classification);
  });

  it('stub output is deterministic per plot + season', async () => {
    const provider = createNdviProvider(process.env);
    const first = await provider.assess({ plotId: 'plot-9', season: '2026-dry' });
    const second = await provider.assess({ plotId: 'plot-9', season: '2026-dry' });
    expect(first).toEqual(second);
  });

  it('stub status advertises the live configuration path', async () => {
    const provider = createNdviProvider(process.env);
    const status = await provider.status();
    expect(status.healthy).toBe(true);
    expect(status.detail).toContain('CROP_ML_URL');
  });

  it('live mode requires CROP_ML_URL and fails closed without it', () => {
    process.env.CROP_ML_DRIVER = 'http';
    expect(() => createNdviProvider(process.env)).toThrow(ProviderConfigError);
  });

  it('live mode maps the real crop-ml assess-plot response (basis live)', async () => {
    process.env.CROP_ML_DRIVER = 'http';
    process.env.CROP_ML_URL = 'http://crop-ml.test';
    // Mirrors the shipped sidecar schema (services/crop-ml/app/models.py
    // AssessPlotResponse): score at health.score, label under
    // seasonality.classification, provenance via top-level provider.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          plot_id: 'plot-1',
          season: '2026-wet',
          provider: 'live',
          seasonality: {
            plot_id: 'plot-1',
            acquisitions: 8,
            ndvi: [{ date: '2026-06-15', ndvi: 0.81 }],
            phenology: {
              sos_date: '2026-04-10',
              eos_date: '2026-09-01',
              peak_date: '2026-06-15',
              peak_value: 0.81,
              base_value: 0.2,
              amplitude: 0.61,
              season_length_days: 144
            },
            mean_ndvi: 0.55,
            reference_phenology: null,
            classification: { label: 'normal', reason_codes: ['within_baseline'] }
          },
          health: {
            plot_id: 'plot-1',
            score: 71.6,
            drivers: [{ code: 'ndvi_deficit', impact: 9.4, detail: 'mean NDVI below baseline' }],
            current_phenology: {
              sos_date: '2026-04-10',
              eos_date: '2026-09-01',
              peak_date: '2026-06-15',
              peak_value: 0.81,
              base_value: 0.2,
              amplitude: 0.61,
              season_length_days: 144
            },
            baseline_phenology: {
              sos_date: '2026-04-01',
              eos_date: '2026-09-05',
              peak_date: '2026-06-10',
              peak_value: 0.88,
              base_value: 0.19,
              amplitude: 0.69,
              season_length_days: 157
            }
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = createNdviProvider(process.env);
    expect(provider.name).toBe('http');
    const assessment = await provider.assess({ plotId: 'plot-1', season: '2026-wet' });
    expect(assessment).toMatchObject({ healthScore: 72, classification: 'normal', basis: 'live' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://crop-ml.test/v1/crop/assess-plot');
    expect(JSON.parse(String(init?.body))).toMatchObject({ plot_id: 'plot-1', season: '2026-wet' });
  });

  it('live mode surfaces provider errors (fail-closed, classified)', async () => {
    process.env.CROP_ML_DRIVER = 'http';
    process.env.CROP_ML_URL = 'http://crop-ml.test';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }))
    );
    const provider = createNdviProvider(process.env);
    await expect(provider.assess({ plotId: 'p', season: '2026-wet' })).rejects.toThrow(
      ProviderHttpError
    );
  });

  it('classifies provider errors for the 503 mapping', () => {
    expect(isNdviProviderError(new ProviderConfigError('crop-ml', ['CROP_ML_URL']))).toBe(true);
    expect(isNdviProviderError(new Error('boom'))).toBe(false);
  });
});
