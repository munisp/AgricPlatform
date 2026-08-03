/**
 * Crop-intel clients (wave-geocredit): the crop-ml sidecar
 * (services/crop-ml, FastAPI, port 8100) is an OPTIONAL integration, built
 * by a sibling wave against the FIXED contract below — do not diverge:
 *
 *   POST /v1/crop/assess-plot
 *     request  { plot_id: string, geometry?: object, season?: string }
 *     response { plot_id, season, health_score: number (0-100),
 *                phenology: { sos, eos, peak }, classification:
 *                'normal'|'delayed'|'stressed', drivers: string[],
 *                basis: 'stub'|'live' }
 *   GET /healthz
 *
 * The stub client is the default (CROP_ML_DRIVER unset) and returns a
 * deterministic, hash-seeded, clearly-labelled fixture. The http client
 * calls the sidecar with a 5s timeout, 2 retries and a circuit breaker
 * (5 consecutive failures open the circuit for 60s, checked at call time).
 * FAIL-CLOSED: when CROP_ML_DRIVER=http but the URL is missing or the
 * sidecar is unreachable, callers get a provider error — the stub is NEVER
 * silently substituted when live inference was configured.
 */
import {
  httpJson,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  requireEnv
} from '../../integrations/drivers/http.js';

/** POST timeout per attempt. */
export const CROP_ML_TIMEOUT_MS = 5_000;
/** Retries after the first attempt (so 3 attempts total) on 5xx/network. */
export const CROP_ML_RETRIES = 2;
/** Consecutive failures before the circuit opens. */
export const CROP_ML_CIRCUIT_THRESHOLD = 5;
/** How long the circuit stays open (checked at call time — no timers). */
export const CROP_ML_CIRCUIT_COOLDOWN_MS = 60_000;
/** Health-probe timeout for the status endpoint. */
export const CROP_ML_HEALTH_TIMEOUT_MS = 2_500;

export interface CropAssessInput {
  plotId: string;
  geometry?: unknown;
  season?: string;
}

/** Mirrors the crop-ml assess-plot response (snake_case mapped to camel). */
export interface CropPlotAssessment {
  plotId: string;
  season: string | null;
  /** 0–100 vegetation health from the fixed contract. */
  healthScore: number;
  phenology: {
    sos: string | null;
    eos: string | null;
    peak: { date: string; value: number } | null;
  };
  classification: 'normal' | 'delayed' | 'stressed';
  drivers: string[];
  /** Honest provenance label from the sidecar itself. */
  basis: 'stub' | 'live';
}

export interface CropIntelStatus {
  configured: boolean;
  healthy: boolean;
  detail: string;
}

export interface CropIntelClient {
  readonly name: 'stub' | 'http';
  assessPlot(input: CropAssessInput): Promise<CropPlotAssessment>;
  status(): Promise<CropIntelStatus>;
}

/** Deterministic 32-bit FNV-1a hash — stub output is stable per plot. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function classificationFor(healthScore: number): CropPlotAssessment['classification'] {
  if (healthScore >= 67) return 'normal';
  if (healthScore >= 34) return 'delayed';
  return 'stressed';
}

/**
 * Deterministic labelled fixture: health_score is a pure function of
 * plot_id (+ season when given), so CI and shadow recomputation are stable.
 * Every field is labelled as simulated.
 */
export class StubCropIntelClient implements CropIntelClient {
  readonly name = 'stub' as const;

  assessPlot(input: CropAssessInput): Promise<CropPlotAssessment> {
    const hash = fnv1a(`${input.plotId}:${input.season ?? ''}`);
    const healthScore = hash % 101;
    return Promise.resolve({
      plotId: input.plotId,
      season: input.season ?? null,
      healthScore,
      phenology: { sos: null, eos: null, peak: null },
      classification: classificationFor(healthScore),
      drivers: ['stub-fixture (simulated — not a live crop assessment)'],
      basis: 'stub'
    });
  }

  status(): Promise<CropIntelStatus> {
    return Promise.resolve({
      configured: true,
      healthy: true,
      detail:
        'Stub client: deterministic simulated fixture. Set CROP_ML_DRIVER=http and CROP_ML_URL to enable the crop-ml sidecar.'
    });
  }
}

interface CropMlAssessResponse {
  plot_id?: string;
  season?: string | null;
  health_score?: number;
  phenology?: {
    sos?: string | null;
    eos?: string | null;
    peak?: { date: string; value: number } | null;
  } | null;
  classification?: string;
  drivers?: string[];
  basis?: string;
}

/**
 * Live client against the crop-ml sidecar. 5s timeout per attempt, 2
 * retries on 5xx/network (never on 4xx), and a circuit breaker that opens
 * after 5 consecutive failures for 60s.
 */
export class HttpCropIntelClient implements CropIntelClient {
  readonly name = 'http' as const;

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(private readonly baseUrl: string) {}

  async assessPlot(input: CropAssessInput): Promise<CropPlotAssessment> {
    this.assertCircuitClosed();
    try {
      const response = await this.requestWithRetries(input);
      this.recordSuccess();
      return this.mapAssessment(input, response);
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  async status(): Promise<CropIntelStatus> {
    try {
      await httpJson('crop-ml', `${this.baseUrl}/healthz`, {
        method: 'GET',
        timeoutMs: CROP_ML_HEALTH_TIMEOUT_MS
      });
      return { configured: true, healthy: true, detail: 'crop-ml sidecar reachable.' };
    } catch {
      return {
        configured: true,
        healthy: false,
        detail: `crop-ml sidecar unreachable at ${this.baseUrl}.`
      };
    }
  }

  /** Visible for tests: whether the circuit breaker is currently open. */
  get circuitOpen(): boolean {
    return (
      this.consecutiveFailures >= CROP_ML_CIRCUIT_THRESHOLD &&
      Date.now() < this.circuitOpenUntil
    );
  }

  private async requestWithRetries(input: CropAssessInput): Promise<CropMlAssessResponse> {
    const body: Record<string, unknown> = { plot_id: input.plotId };
    if (input.geometry !== undefined) body.geometry = input.geometry;
    if (input.season !== undefined) body.season = input.season;
    let lastError: unknown;
    for (let attempt = 0; attempt <= CROP_ML_RETRIES; attempt += 1) {
      try {
        return await httpJson<CropMlAssessResponse>(
          'crop-ml',
          `${this.baseUrl}/v1/crop/assess-plot`,
          { body, timeoutMs: CROP_ML_TIMEOUT_MS }
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
        'crop-ml',
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
    if (this.consecutiveFailures >= CROP_ML_CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + CROP_ML_CIRCUIT_COOLDOWN_MS;
    }
  }

  private mapAssessment(
    input: CropAssessInput,
    response: CropMlAssessResponse
  ): CropPlotAssessment {
    const rawScore = Number(response.health_score ?? 0);
    const healthScore = Math.min(100, Math.max(0, Math.round(rawScore)));
    const classification =
      response.classification === 'normal' ||
      response.classification === 'delayed' ||
      response.classification === 'stressed'
        ? response.classification
        : classificationFor(healthScore);
    return {
      plotId: response.plot_id ?? input.plotId,
      season: response.season ?? input.season ?? null,
      healthScore,
      phenology: {
        sos: response.phenology?.sos ?? null,
        eos: response.phenology?.eos ?? null,
        peak: response.phenology?.peak ?? null
      },
      classification,
      drivers: Array.isArray(response.drivers) ? response.drivers : [],
      basis: response.basis === 'live' ? 'live' : 'stub'
    };
  }
}

export { ProviderConfigError, ProviderHttpError, ProviderRequestError };

/**
 * Builds the configured client. Default is the stub; CROP_ML_DRIVER=http
 * requires CROP_ML_URL and fails closed with ProviderConfigError otherwise.
 */
export function createCropIntelClient(env: NodeJS.ProcessEnv = process.env): CropIntelClient {
  const flag = (env.CROP_ML_DRIVER ?? 'stub').toLowerCase();
  if (flag === 'http') {
    const baseUrl = requireEnv('crop-ml', env, ['CROP_ML_URL']).replace(/\/+$/, '');
    return new HttpCropIntelClient(baseUrl);
  }
  return new StubCropIntelClient();
}
