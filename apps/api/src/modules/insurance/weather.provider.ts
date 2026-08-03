/**
 * Weather observation provider (wave-insurance): the observation source for
 * parametric rainfall/heat triggers, behind one port. The STUB provider is
 * the default (WEATHER_API_URL unset) and returns a deterministic,
 * hash-seeded daily series per h3 cell + season, labelled basis:'stub' —
 * never presented as a live observation. The LIVE provider
 * (WEATHER_API_URL + WEATHER_API_KEY) fetches observations with a 5s
 * timeout, 2 retries and a call-time circuit breaker.
 *
 * FAIL-CLOSED (mirrors the geo-intel flood-ml doctrine): when the live
 * provider is configured but unreachable, observe() throws a provider error
 * and the trigger evaluation run marks the affected cells 'unavailable' and
 * answers 503 — the stub is NEVER silently substituted.
 */
import {
  httpJson,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  requireEnv
} from '../integrations/drivers/http.js';

/** Per-attempt timeout. */
export const WEATHER_TIMEOUT_MS = 5_000;
/** Retries after the first attempt (3 attempts total) on 5xx/network. */
export const WEATHER_RETRIES = 2;
/** Consecutive failures before the circuit opens. */
export const WEATHER_CIRCUIT_THRESHOLD = 3;
/** How long the circuit stays open (checked at call time — no timers). */
export const WEATHER_CIRCUIT_COOLDOWN_MS = 30_000;

export interface WeatherObservationInput {
  h3Cell: string;
  season: string;
  windowDays: number;
}

export interface WeatherObservationSeries {
  h3Cell: string;
  season: string;
  /** Daily rainfall totals (mm, one decimal) for the observation window. */
  rainfallMm: number[];
  /** Daily maximum temperatures (°C, one decimal) for the window. */
  maxTempC: number[];
  /** Honest provenance label. */
  basis: 'stub' | 'live';
}

export interface WeatherProviderStatus {
  configured: boolean;
  healthy: boolean;
  detail: string;
}

export interface InsuranceWeatherProvider {
  readonly name: 'stub' | 'http';
  observe(input: WeatherObservationInput): Promise<WeatherObservationSeries>;
  status(): Promise<WeatherProviderStatus>;
}

/** Deterministic 32-bit FNV-1a hash — stub series are stable per cell+season. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic labelled fixture: each day is a pure function of
 * (h3Cell, season, dayIndex) scaled by a per-cell seasonal factor
 * (0–0.99), so cells vary from near-drought to near-normal and both
 * triggering and non-triggering outcomes occur — while re-runs stay
 * byte-stable. Rainfall spans 0–4.9 mm/day × cell factor (deficit products
 * trigger for dry cells); max temperature spans 28 °C + 0–14.9 °C × cell
 * factor (heat products trigger for hot cells).
 */
export class StubWeatherProvider implements InsuranceWeatherProvider {
  readonly name = 'stub' as const;

  observe(input: WeatherObservationInput): Promise<WeatherObservationSeries> {
    const cellFactor = (fnv1a(`${input.h3Cell}:${input.season}:factor`) % 100) / 100;
    const rainfallMm: number[] = [];
    const maxTempC: number[] = [];
    for (let day = 0; day < input.windowDays; day += 1) {
      const rainHash = fnv1a(`${input.h3Cell}:${input.season}:rain:${day}`);
      const tempHash = fnv1a(`${input.h3Cell}:${input.season}:temp:${day}`);
      rainfallMm.push(Math.round(cellFactor * ((rainHash % 50) / 10) * 10) / 10);
      maxTempC.push(Math.round((28 + cellFactor * ((tempHash % 150) / 10)) * 10) / 10);
    }
    return Promise.resolve({
      h3Cell: input.h3Cell,
      season: input.season,
      rainfallMm,
      maxTempC,
      basis: 'stub'
    });
  }

  status(): Promise<WeatherProviderStatus> {
    return Promise.resolve({
      configured: true,
      healthy: true,
      detail:
        'Stub provider: deterministic simulated observations. Set WEATHER_API_URL and WEATHER_API_KEY to enable the live weather provider.'
    });
  }
}

/** Live provider contract (docs/parametric-insurance.md §weather contract). */
interface WeatherApiObservationsResponse {
  rainfall_mm?: Array<number | null>;
  max_temp_c?: Array<number | null>;
}

/**
 * Live provider against a contracted weather API. 5s timeout per attempt,
 * 2 retries on 5xx/network (never on 4xx), and a circuit breaker that opens
 * after WEATHER_CIRCUIT_THRESHOLD consecutive failures for the cooldown.
 */
export class HttpWeatherProvider implements InsuranceWeatherProvider {
  readonly name = 'http' as const;

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  async observe(input: WeatherObservationInput): Promise<WeatherObservationSeries> {
    this.assertCircuitClosed();
    try {
      const response = await this.requestWithRetries(input);
      this.recordSuccess();
      return this.mapSeries(input, response);
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  async status(): Promise<WeatherProviderStatus> {
    try {
      await httpJson('weather', `${this.baseUrl}/healthz`, {
        method: 'GET',
        headers: this.headers(),
        timeoutMs: 2_500
      });
      return { configured: true, healthy: true, detail: 'Weather provider reachable.' };
    } catch {
      return {
        configured: true,
        healthy: false,
        detail: `Weather provider unreachable at ${this.baseUrl}.`
      };
    }
  }

  /** Visible for tests: whether the circuit breaker is currently open. */
  get circuitOpen(): boolean {
    return (
      this.consecutiveFailures >= WEATHER_CIRCUIT_THRESHOLD &&
      Date.now() < this.circuitOpenUntil
    );
  }

  private headers(): Record<string, string> {
    return { 'x-api-key': this.apiKey };
  }

  private async requestWithRetries(
    input: WeatherObservationInput
  ): Promise<WeatherApiObservationsResponse> {
    const query = new URLSearchParams({
      cell: input.h3Cell,
      season: input.season,
      days: String(input.windowDays)
    });
    let lastError: unknown;
    for (let attempt = 0; attempt <= WEATHER_RETRIES; attempt += 1) {
      try {
        return await httpJson<WeatherApiObservationsResponse>(
          'weather',
          `${this.baseUrl}/v1/observations?${query.toString()}`,
          { method: 'GET', headers: this.headers(), timeoutMs: WEATHER_TIMEOUT_MS }
        );
      } catch (error) {
        // 4xx is a contract violation — retrying cannot help.
        if (error instanceof ProviderHttpError && error.status < 500) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError;
  }

  private assertCircuitClosed(): void {
    if (this.circuitOpen) {
      throw new ProviderRequestError(
        'weather',
        'network',
        new Error(
          `circuit open after ${this.consecutiveFailures} consecutive failures; retry after cooldown`
        )
      );
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= WEATHER_CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + WEATHER_CIRCUIT_COOLDOWN_MS;
    }
  }

  private mapSeries(
    input: WeatherObservationInput,
    response: WeatherApiObservationsResponse
  ): WeatherObservationSeries {
    const rainfallMm = (response.rainfall_mm ?? []).map((value) => value ?? 0);
    const maxTempC = (response.max_temp_c ?? []).map((value) => value ?? 0);
    return {
      h3Cell: input.h3Cell,
      season: input.season,
      rainfallMm,
      maxTempC,
      basis: 'live'
    };
  }
}

export { ProviderConfigError, ProviderHttpError, ProviderRequestError };

/**
 * Builds the configured provider. Default is the stub; selecting the live
 * provider requires BOTH WEATHER_API_URL and WEATHER_API_KEY and fails
 * closed with ProviderConfigError otherwise.
 */
export function createWeatherProvider(
  env: NodeJS.ProcessEnv = process.env
): InsuranceWeatherProvider {
  if (env.WEATHER_API_URL) {
    const baseUrl = env.WEATHER_API_URL.replace(/\/+$/, '');
    const apiKey = requireEnv('weather', env, ['WEATHER_API_KEY']);
    return new HttpWeatherProvider(baseUrl, apiKey);
  }
  return new StubWeatherProvider();
}
