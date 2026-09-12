/**
 * Weather feed driver (wave P1): Open-Meteo is the real default adapter —
 * it is an open API needing NO credentials (docs/integration-matrix.md
 * M5). The stub fixture stays the default WEATHER_DRIVER so CI remains
 * deterministic; setting WEATHER_DRIVER=sandbox|production switches the
 * advisory weather snapshot path to live Open-Meteo forecasts with a
 * 15-minute cache (Redis when REDIS_URL is configured, in-process
 * otherwise). NiMet remains an MoU-gated P2 feed.
 */
import type { KeyValueStore } from '../../../redis/key-value-store.js';
import type { WeatherSnapshot } from '../adapters.js';
import { httpJson, ProviderHttpError } from './http.js';
import { lookupStateCentroid } from './nigeria-states.js';

const OPEN_METEO_BASE_URL = 'https://api.open-meteo.com';

/** 15-minute freshness window for weather snapshots. */
export const WEATHER_CACHE_TTL_MS = 15 * 60 * 1000;

export interface WeatherProvider {
  readonly name: string;
  snapshot(state: string): Promise<WeatherSnapshot>;
  /**
   * Per-coordinate daily precipitation forecast (Stage 27 Planting-Window
   * Pulse). Same Open-Meteo feed, same fail-closed error contract as
   * snapshot(): failures throw ProviderHttpError/ProviderRequestError —
   * callers must never substitute fabricated rain data.
   */
  dailyForecast(latitude: number, longitude: number, days?: number): Promise<DailyForecast>;
}

/** One forecast day of the per-coordinate daily series. */
export interface DailyForecastPoint {
  /** ISO calendar day (yyyy-mm-dd, Africa/Lagos timezone). */
  date: string;
  precipitationMm: number;
}

/** Per-coordinate daily forecast with an honest fetch timestamp. */
export interface DailyForecast {
  latitude: number;
  longitude: number;
  daily: DailyForecastPoint[];
  /**
   * ISO timestamp of the successful upstream fetch. Consumers MUST apply a
   * freshness gate on this stamp — a cached snapshot never outlives the
   * cache TTL, but the stamp keeps the guarantee if the cache is bypassed.
   */
  fetchedAt: string;
  source: string;
}

/** Default per-coordinate forecast horizon for planting-window generation. */
export const DAILY_FORECAST_DAYS = 14;

interface OpenMeteoForecast {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    precipitation?: number;
  };
  daily?: {
    time?: string[];
    precipitation_sum?: Array<number | null>;
  };
}

function outlookFor(next48hRainMm: number, currentPrecipitation: number): string {
  if (currentPrecipitation > 0.5) {
    return 'Rain currently falling; expect wet field conditions today';
  }
  if (next48hRainMm >= 10) {
    return 'Significant rain expected within 48 hours — delay spraying/fertiliser application';
  }
  if (next48hRainMm > 0.5) {
    return 'Light showers expected within 48 hours';
  }
  return 'Dry spell likely this week — plan irrigation where available';
}

/** Open-Meteo forecast adapter (no API key required). */
export class OpenMeteoWeatherProvider implements WeatherProvider {
  readonly name = 'open-meteo';

  constructor(private readonly baseUrl: string = OPEN_METEO_BASE_URL) {}

  async snapshot(state: string): Promise<WeatherSnapshot> {
    const centroid = lookupStateCentroid(state);
    if (!centroid) {
      throw new Error(`Unknown Nigerian state '${state}' — no centroid available for weather lookup`);
    }
    const query = new URLSearchParams({
      latitude: String(centroid.latitude),
      longitude: String(centroid.longitude),
      current: 'temperature_2m,relative_humidity_2m,precipitation',
      daily: 'precipitation_sum',
      forecast_days: '3',
      timezone: 'Africa/Lagos'
    });
    const forecast = await httpJson<OpenMeteoForecast>(
      this.name,
      `${this.baseUrl}/v1/forecast?${query.toString()}`,
      { method: 'GET' }
    );
    const current = forecast.current ?? {};
    const next48hRainMm = (forecast.daily?.precipitation_sum ?? [])
      .slice(0, 2)
      .reduce((sum: number, value) => sum + (value ?? 0), 0);
    const currentPrecipitation = current.precipitation ?? 0;
    return {
      state: centroid.state,
      temperatureCelsius: current.temperature_2m ?? 0,
      humidityPercent: current.relative_humidity_2m ?? 0,
      rainfallMm: Math.round(next48hRainMm * 10) / 10,
      outlook: outlookFor(next48hRainMm, currentPrecipitation),
      source: 'Open-Meteo (open data, CC-BY 4.0)'
    };
  }

  async dailyForecast(
    latitude: number,
    longitude: number,
    days: number = DAILY_FORECAST_DAYS
  ): Promise<DailyForecast> {
    const query = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      daily: 'precipitation_sum',
      forecast_days: String(days),
      timezone: 'Africa/Lagos'
    });
    const forecast = await httpJson<OpenMeteoForecast>(
      this.name,
      `${this.baseUrl}/v1/forecast?${query.toString()}`,
      { method: 'GET' }
    );
    const dates = forecast.daily?.time ?? [];
    const rain = forecast.daily?.precipitation_sum ?? [];
    const daily: DailyForecastPoint[] = dates.map((date, index) => ({
      date,
      precipitationMm: rain[index] ?? 0
    }));
    if (daily.length === 0) {
      // Fail closed: an empty series is unusable for agronomy — treat it as
      // a provider failure (HTTP 200 with an unusable payload) rather than
      // fabricating a dry forecast.
      throw new ProviderHttpError(this.name, 200, 'Open-Meteo returned an empty daily series');
    }
    return {
      latitude,
      longitude,
      daily,
      fetchedAt: new Date().toISOString(),
      source: 'Open-Meteo (open data, CC-BY 4.0)'
    };
  }
}

interface CachedSnapshot {
  snapshot: WeatherSnapshot;
  expiresAt: number;
}

/**
 * 15-minute cache wrapper over any WeatherProvider, backed by the shared
 * KeyValueStore — Redis in deployed environments, in-process memory
 * otherwise (same store as the idempotency/OTP infrastructure).
 */
export class CachedWeatherProvider implements WeatherProvider {
  readonly name: string;

  constructor(
    private readonly delegate: WeatherProvider,
    private readonly kv: KeyValueStore,
    private readonly ttlMs: number = WEATHER_CACHE_TTL_MS
  ) {
    this.name = `${delegate.name}+cache`;
  }

  async snapshot(state: string): Promise<WeatherSnapshot> {
    const key = `weather:snapshot:${state.toLowerCase().trim()}`;
    const cached = await this.kv.get(key).catch(() => undefined);
    if (cached) {
      try {
        const entry = JSON.parse(cached) as CachedSnapshot;
        if (entry.expiresAt > Date.now()) {
          return entry.snapshot;
        }
      } catch {
        // Corrupt cache entry — fall through to a fresh fetch.
      }
    }
    const snapshot = await this.delegate.snapshot(state);
    const entry: CachedSnapshot = { snapshot, expiresAt: Date.now() + this.ttlMs };
    await this.kv.set(key, JSON.stringify(entry), this.ttlMs).catch(() => undefined);
    return snapshot;
  }

  /**
   * Cached per-coordinate forecast. Coordinates are snapped to 3 decimals
   * (~110 m grid) for the cache key — plot-level precision is preserved
   * while nearby plots share one upstream call, and no finer location is
   * persisted in the shared cache.
   */
  async dailyForecast(
    latitude: number,
    longitude: number,
    days: number = DAILY_FORECAST_DAYS
  ): Promise<DailyForecast> {
    const key = `weather:daily:${latitude.toFixed(3)}:${longitude.toFixed(3)}:${days}`;
    const cached = await this.kv.get(key).catch(() => undefined);
    if (cached) {
      try {
        const entry = JSON.parse(cached) as { forecast: DailyForecast; expiresAt: number };
        if (entry.expiresAt > Date.now()) {
          return entry.forecast;
        }
      } catch {
        // Corrupt cache entry — fall through to a fresh fetch.
      }
    }
    const forecast = await this.delegate.dailyForecast(latitude, longitude, days);
    await this.kv
      .set(key, JSON.stringify({ forecast, expiresAt: Date.now() + this.ttlMs }), this.ttlMs)
      .catch(() => undefined);
    return forecast;
  }
}

/**
 * Builds the live weather provider. Open-Meteo is the real default feed
 * (no credentials required); `kv` enables the 15-minute cache.
 */
export function createWeatherProvider(kv?: KeyValueStore): WeatherProvider {
  const provider = new OpenMeteoWeatherProvider();
  return kv ? new CachedWeatherProvider(provider, kv) : provider;
}
