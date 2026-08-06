import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWeatherProvider,
  HttpWeatherProvider,
  ProviderConfigError,
  ProviderRequestError,
  StubWeatherProvider,
  WEATHER_CIRCUIT_THRESHOLD,
  WEATHER_RETRIES
} from './weather.provider.js';

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

const INPUT = { h3Cell: '8741e68dfffffff', season: '2026-wet', windowDays: 30 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('StubWeatherProvider', () => {
  it('is deterministic per h3 cell + season (hash-seeded)', async () => {
    const provider = new StubWeatherProvider();
    const first = await provider.observe(INPUT);
    const second = await provider.observe(INPUT);
    expect(first).toEqual(second);
  });

  it('produces honestly-labelled stub series of the requested length', async () => {
    const provider = new StubWeatherProvider();
    const series = await provider.observe(INPUT);
    expect(series.basis).toBe('stub');
    expect(series.rainfallMm).toHaveLength(30);
    expect(series.maxTempC).toHaveLength(30);
    for (const value of series.rainfallMm) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(5);
    }
    for (const value of series.maxTempC) {
      expect(value).toBeGreaterThanOrEqual(28);
      expect(value).toBeLessThan(45);
    }
  });

  it('varies across cells and seasons (no single global fixture)', async () => {
    const provider = new StubWeatherProvider();
    const a = await provider.observe(INPUT);
    const b = await provider.observe({ ...INPUT, h3Cell: '8741e68efffffff' });
    const c = await provider.observe({ ...INPUT, season: '2026-dry' });
    expect(a.rainfallMm).not.toEqual(b.rainfallMm);
    expect(a.rainfallMm).not.toEqual(c.rainfallMm);
  });

  it('status reports the deterministic stub configuration', async () => {
    const status = await new StubWeatherProvider().status();
    expect(status.healthy).toBe(true);
    expect(status.detail).toContain('Stub provider');
  });
});

describe('createWeatherProvider — fail-closed factory', () => {
  it('defaults to the stub when WEATHER_API_URL is unset', () => {
    expect(createWeatherProvider({}).name).toBe('stub');
  });

  it('fails closed when WEATHER_API_URL is set without WEATHER_API_KEY', () => {
    expect(() => createWeatherProvider({ WEATHER_API_URL: 'https://weather.example' })).toThrow(
      ProviderConfigError
    );
  });

  it('selects the live provider when both variables are configured', () => {
    const provider = createWeatherProvider({
      WEATHER_API_URL: 'https://weather.example/',
      WEATHER_API_KEY: 'secret'
    });
    expect(provider.name).toBe('http');
  });
});

describe('HttpWeatherProvider', () => {
  it('maps live observations and labels them basis live', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        jsonResponse({ rainfall_mm: [1, 2, null], max_temp_c: [38, 39, 30] })
      )
    );
    const provider = new HttpWeatherProvider('https://weather.example', 'secret');
    const series = await provider.observe({ ...INPUT, windowDays: 3 });
    expect(series.basis).toBe('live');
    expect(series.rainfallMm).toEqual([1, 2, 0]);
    expect(series.maxTempC).toEqual([38, 39, 30]);
  });

  it('sends the API key header and the cell/season/days query', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => jsonResponse({ rainfall_mm: [], max_temp_c: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new HttpWeatherProvider('https://weather.example', 'secret');
    await provider.observe(INPUT);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/observations');
    expect(url).toContain('cell=8741e68dfffffff');
    expect(url).toContain('season=2026-wet');
    expect(url).toContain('days=30');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('secret');
  });

  it('retries on network failure then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('socket hangup'))
      .mockImplementation(() => jsonResponse({ rainfall_mm: [5], max_temp_c: [35] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new HttpWeatherProvider('https://weather.example', 'secret');
    const series = await provider.observe({ ...INPUT, windowDays: 1 });
    expect(series.rainfallMm).toEqual([5]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed after exhausting retries (never silently stubs)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('unreachable')));
    const provider = new HttpWeatherProvider('https://weather.example', 'secret');
    await expect(provider.observe(INPUT)).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it('does not retry 4xx contract violations', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ error: 'bad key' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new HttpWeatherProvider('https://weather.example', 'secret');
    await expect(provider.observe(INPUT)).rejects.toThrow(/HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens the circuit after consecutive failures and fails fast', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('unreachable'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new HttpWeatherProvider('https://weather.example', 'secret');
    for (let i = 0; i < WEATHER_CIRCUIT_THRESHOLD; i += 1) {
      await expect(provider.observe(INPUT)).rejects.toBeInstanceOf(ProviderRequestError);
    }
    expect(provider.circuitOpen).toBe(true);
    const callsBefore = fetchMock.mock.calls.length;
    await expect(provider.observe(INPUT)).rejects.toThrow(/circuit open/);
    expect(fetchMock.mock.calls.length).toBe(callsBefore); // fail fast, no new attempt
    expect(callsBefore).toBe(WEATHER_CIRCUIT_THRESHOLD * (WEATHER_RETRIES + 1));
  });
});
