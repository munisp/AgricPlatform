import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryKeyValueStore } from '../../../redis/key-value-store.js';
import { ProviderHttpError } from './http.js';
import { lookupStateCentroid, NIGERIA_STATE_CENTROIDS } from './nigeria-states.js';
import {
  CachedWeatherProvider,
  createWeatherProvider,
  OpenMeteoWeatherProvider
} from './weather.drivers.js';

function forecastResponse(): Response {
  return new Response(
    JSON.stringify({
      current: { temperature_2m: 31.4, relative_humidity_2m: 62, precipitation: 0 },
      daily: { precipitation_sum: [2.5, 8.0, 0] }
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Nigeria state centroid table', () => {
  it('covers all 36 states plus the FCT', () => {
    expect(NIGERIA_STATE_CENTROIDS).toHaveLength(37);
  });

  it('looks up states case-insensitively with aliases', () => {
    expect(lookupStateCentroid('kano')?.state).toBe('Kano');
    expect(lookupStateCentroid('  Lagos ')?.state).toBe('Lagos');
    expect(lookupStateCentroid('Abuja')?.state).toBe('FCT');
    expect(lookupStateCentroid('Narnia')).toBeUndefined();
  });
});

describe('OpenMeteoWeatherProvider', () => {
  it('maps the forecast payload onto the WeatherSnapshot contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(forecastResponse());
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenMeteoWeatherProvider();
    const snapshot = await provider.snapshot('Kano');
    expect(snapshot).toEqual({
      state: 'Kano',
      temperatureCelsius: 31.4,
      humidityPercent: 62,
      rainfallMm: 10.5,
      outlook: 'Significant rain expected within 48 hours — delay spraying/fertiliser application',
      source: 'Open-Meteo (open data, CC-BY 4.0)'
    });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('https://api.open-meteo.com/v1/forecast?');
    expect(url).toContain('latitude=11.9914');
    expect(url).toContain('longitude=8.5314');
    expect(url).toContain('timezone=Africa%2FLagos');
  });

  it('produces a dry-spell outlook when no rain is forecast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            current: { temperature_2m: 35, relative_humidity_2m: 20, precipitation: 0 },
            daily: { precipitation_sum: [0, 0, 0] }
          }),
          { status: 200 }
        )
      )
    );
    const provider = new OpenMeteoWeatherProvider();
    const snapshot = await provider.snapshot('Sokoto');
    expect(snapshot.rainfallMm).toBe(0);
    expect(snapshot.outlook).toContain('Dry spell');
  });

  it('rejects unknown states without a network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenMeteoWeatherProvider();
    await expect(provider.snapshot('Narnia')).rejects.toThrow(/Unknown Nigerian state/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps API failures to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })));
    const provider = new OpenMeteoWeatherProvider();
    await expect(provider.snapshot('Lagos')).rejects.toThrow(ProviderHttpError);
  });
});

describe('CachedWeatherProvider (15-minute TTL)', () => {
  it('serves the second read from the cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue(forecastResponse());
    vi.stubGlobal('fetch', fetchMock);
    const provider = new CachedWeatherProvider(new OpenMeteoWeatherProvider(), new InMemoryKeyValueStore());
    const first = await provider.snapshot('Kano');
    const second = await provider.snapshot('Kano');
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL expires', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(forecastResponse()));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new CachedWeatherProvider(
      new OpenMeteoWeatherProvider(),
      new InMemoryKeyValueStore(),
      5
    );
    await provider.snapshot('Kano');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await provider.snapshot('Kano');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls through to a fresh fetch when the cache entry is corrupt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(forecastResponse());
    vi.stubGlobal('fetch', fetchMock);
    const kv = new InMemoryKeyValueStore();
    await kv.set('weather:snapshot:kano', '{not-json');
    const provider = new CachedWeatherProvider(new OpenMeteoWeatherProvider(), kv);
    const snapshot = await provider.snapshot('Kano');
    expect(snapshot.state).toBe('Kano');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createWeatherProvider', () => {
  it('returns the raw Open-Meteo provider without a store, cached with one', () => {
    expect(createWeatherProvider()).toBeInstanceOf(OpenMeteoWeatherProvider);
    expect(createWeatherProvider(new InMemoryKeyValueStore())).toBeInstanceOf(CachedWeatherProvider);
  });
});
