/**
 * Flood-risk drivers (wave ML): the flood-ml sidecar (services/flood-ml,
 * IBM Granite geospatial flood detection ported from farmer-data-collection)
 * is an OPTIONAL integration. The stub driver stays the default
 * FLOOD_ML_DRIVER so CI and local dev remain deterministic; setting
 * FLOOD_ML_DRIVER=http switches assessments to the sidecar's /predict
 * endpoint (env FLOOD_ML_URL). The factory fails closed with
 * ProviderConfigError when http is selected but the URL is absent — the
 * service maps that (and unreachable sidecars) to a 503 in production.
 *
 * The http driver mirrors the crop-ml client shape (crop-intel.drivers.ts):
 * bounded retries with exponential backoff on 5xx/network/timeout (never on
 * 4xx, which is a contract violation), a raised per-attempt timeout sized
 * for the sidecar's cold path (model load + Sentinel-2 + Sentinel-1 SAR
 * fetches + preprocess + inference), and a call-time circuit breaker. On
 * retry exhaustion the last provider error propagates — the stub is NEVER
 * silently substituted when live inference was configured.
 */
import {
  httpJson,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  requireEnv
} from '../integrations/drivers/http.js';

/**
 * POST timeout per attempt. Raised far above the shared 5s provider default:
 * a cold sidecar performs model load + two satellite fetches (Sentinel-2 and
 * Sentinel-1 SAR) + preprocessing + inference per request
 * (services/flood-ml/app.py), which systematically exceeded 5s (GAP-M01).
 */
export const FLOOD_ML_TIMEOUT_MS = 30_000;
/** Retries after the first attempt (so 3 attempts total) on 5xx/network. */
export const FLOOD_ML_RETRIES = 2;
/** Base backoff between retries; doubles per attempt (1s, 2s, ...). */
export const FLOOD_ML_RETRY_BACKOFF_MS = 1_000;
/** Number of consecutive sidecar failures before the circuit opens. */
export const FLOOD_ML_CIRCUIT_THRESHOLD = 3;
/** How long the circuit stays open before the next call is allowed through. */
export const FLOOD_ML_CIRCUIT_COOLDOWN_MS = 30_000;
/** Health-probe timeout for the status endpoint. */
export const FLOOD_ML_HEALTH_TIMEOUT_MS = 2_500;

export interface FloodRiskAssessInput {
  latitude: number;
  longitude: number;
}

export interface FloodRiskAssessment {
  floodDetected: boolean;
  severity: string;
  /** Share of the assessed bounding box classified as flooded (0-100). */
  floodPercentage: number;
  floodAreaKm2: number;
  /** Mean model confidence 0-1 (stub reports a fixed fixture value). */
  confidence: number;
  /**
   * Provenance of the assessment, mapped from the sidecar's own `basis`
   * field: 'live' = real model inference over satellite imagery, 'mock' =
   * simulated fixture (the sidecar's mock endpoint AND this client's stub
   * driver). Never presented as live when mock (GAP-M02).
   */
  basis: 'live' | 'mock';
  /** Honest provenance label — never presented as live satellite verification. */
  source: string;
  assessedAt: string;
  message: string;
  recommendedActions: string[];
}

export interface FloodRiskDriverStatus {
  configured: boolean;
  healthy: boolean;
  detail: string;
}

export interface FloodRiskDriver {
  readonly name: 'stub' | 'http';
  assess(input: FloodRiskAssessInput): Promise<FloodRiskAssessment>;
  status(): Promise<FloodRiskDriverStatus>;
}

/** Deterministic 32-bit FNV-1a hash so stub output is stable per coordinate. */
function coordinateHash(latitude: number, longitude: number): number {
  const text = `${latitude.toFixed(4)}:${longitude.toFixed(4)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function severityFor(floodPercentage: number): string {
  if (floodPercentage >= 20) return 'severe';
  if (floodPercentage >= 10) return 'high';
  if (floodPercentage >= 5) return 'moderate';
  if (floodPercentage >= 1) return 'low';
  return 'none';
}

/**
 * Deterministic labelled fixture for local development and CI. Same
 * coordinates always yield the same assessment; every field is labelled as
 * simulated so it can never be mistaken for live satellite verification.
 */
export class StubFloodRiskDriver implements FloodRiskDriver {
  readonly name = 'stub' as const;

  assess(input: FloodRiskAssessInput): Promise<FloodRiskAssessment> {
    const hash = coordinateHash(input.latitude, input.longitude);
    // 0-24% in 0.1 steps, fully determined by the coordinates.
    const floodPercentage = (hash % 241) / 10;
    const floodAreaKm2 = Math.round(25 * (floodPercentage / 100) * 100) / 100;
    const severity = severityFor(floodPercentage);
    const floodDetected = floodPercentage >= 1;
    return Promise.resolve({
      floodDetected,
      severity,
      floodPercentage,
      floodAreaKm2,
      confidence: 0.5,
      basis: 'mock',
      source: 'stub-fixture (simulated — not a live satellite assessment)',
      assessedAt: new Date().toISOString(),
      message: floodDetected
        ? `Simulated flood risk '${severity}' for this location (stub driver fixture).`
        : 'Simulated all-clear for this location (stub driver fixture).',
      recommendedActions: floodDetected
        ? ['Enable the flood-ml sidecar for model-based assessments.']
        : []
    });
  }

  status(): Promise<FloodRiskDriverStatus> {
    return Promise.resolve({
      configured: true,
      healthy: true,
      detail:
        'Stub driver: deterministic simulated fixture. Set FLOOD_ML_DRIVER=http and FLOOD_ML_URL to enable the flood-ml sidecar.'
    });
  }
}

/** Response shape of the sidecar's POST /predict (FastAPI snake_case). */
interface FloodMlPredictResponse {
  flood_detected?: boolean;
  severity?: string;
  flood_percentage?: number;
  flood_area_km2?: number;
  avg_confidence?: number;
  timestamp?: string;
  message?: string;
  recommended_actions?: string[];
  /** Sidecar provenance: 'live' model inference | 'mock' simulated fixture. */
  basis?: string;
}

interface FloodMlHealthResponse {
  status?: string;
  sentinel_hub_configured?: boolean;
}

/** Fail-closed contract violation — never fabricate a provenance label. */
function contractViolation(detail: string): ProviderRequestError {
  return new ProviderRequestError(
    'flood-ml',
    'network',
    new Error(`malformed /predict response: ${detail}`)
  );
}

/** Default inter-retry sleep; injectable for deterministic tests. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Live driver against the flood-ml sidecar. Per attempt: FLOOD_ML_TIMEOUT_MS
 * timeout (cold path = model load + two satellite fetches + inference).
 * Retries: FLOOD_ML_RETRIES extra attempts on 5xx/network/timeout with
 * exponential backoff (never on 4xx — a contract violation cannot be healed
 * by retrying). Circuit breaker: after FLOOD_ML_CIRCUIT_THRESHOLD
 * consecutive failures the circuit opens for FLOOD_ML_CIRCUIT_COOLDOWN_MS
 * and calls fail fast with ProviderRequestError (checked at call time — no
 * in-process timers). Retry exhaustion fails closed: the last provider
 * error propagates and is counted towards the circuit.
 */
export class HttpFloodRiskDriver implements FloodRiskDriver {
  readonly name = 'http' as const;

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep
  ) {}

  async assess(input: FloodRiskAssessInput): Promise<FloodRiskAssessment> {
    this.assertCircuitClosed();
    try {
      const response = await this.requestWithRetries(input);
      this.recordSuccess();
      return this.mapAssessment(response);
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  async status(): Promise<FloodRiskDriverStatus> {
    try {
      const health = await httpJson<FloodMlHealthResponse>('flood-ml', `${this.baseUrl}/healthz`, {
        method: 'GET',
        timeoutMs: FLOOD_ML_HEALTH_TIMEOUT_MS
      });
      const sentinel = health.sentinel_hub_configured === true;
      return {
        configured: true,
        healthy: true,
        detail: sentinel
          ? 'flood-ml sidecar reachable; Sentinel Hub credentials configured.'
          : 'flood-ml sidecar reachable, but Sentinel Hub credentials are NOT configured — /predict will answer 503.'
      };
    } catch (error) {
      const reason =
        error instanceof ProviderRequestError && error.reason === 'timeout'
          ? 'health probe timed out'
          : 'health probe failed';
      return {
        configured: true,
        healthy: false,
        detail: `flood-ml sidecar unreachable at ${this.baseUrl} (${reason}).`
      };
    }
  }

  /** Visible for tests: whether the circuit breaker is currently open. */
  get circuitOpen(): boolean {
    return this.consecutiveFailures >= FLOOD_ML_CIRCUIT_THRESHOLD && Date.now() < this.circuitOpenUntil;
  }

  /**
   * Bounded retries with exponential backoff, mirroring the crop-ml driver:
   * 4xx responses are contract violations and are never retried; 5xx,
   * network and timeout failures retry up to FLOOD_ML_RETRIES times. On
   * exhaustion the LAST error propagates (fail closed).
   */
  private async requestWithRetries(input: FloodRiskAssessInput): Promise<FloodMlPredictResponse> {
    const body = { latitude: input.latitude, longitude: input.longitude };
    let lastError: unknown;
    for (let attempt = 0; attempt <= FLOOD_ML_RETRIES; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(FLOOD_ML_RETRY_BACKOFF_MS * 2 ** (attempt - 1));
      }
      try {
        return await httpJson<FloodMlPredictResponse>('flood-ml', `${this.baseUrl}/predict`, {
          body,
          timeoutMs: FLOOD_ML_TIMEOUT_MS
        });
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
        'flood-ml',
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
    if (this.consecutiveFailures >= FLOOD_ML_CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + FLOOD_ML_CIRCUIT_COOLDOWN_MS;
    }
  }

  private mapAssessment(response: FloodMlPredictResponse): FloodRiskAssessment {
    // Fail closed on contract violations: the sidecar stamps every response
    // with basis 'live'|'mock' (services/flood-ml/app.py
    // FloodDetectionResponse). A missing/unknown basis must surface as
    // 'unavailable' upstream — mock data must NEVER be labelled live
    // inference (GAP-M02).
    if (response.basis !== 'live' && response.basis !== 'mock') {
      throw contractViolation(`missing or unknown basis provenance '${String(response.basis)}'`);
    }
    const basis = response.basis;
    return {
      floodDetected: response.flood_detected ?? false,
      severity: response.severity ?? 'unknown',
      floodPercentage: response.flood_percentage ?? 0,
      floodAreaKm2: response.flood_area_km2 ?? 0,
      confidence: response.avg_confidence ?? 0,
      basis,
      source:
        basis === 'live'
          ? 'flood-ml sidecar (IBM Granite geospatial flood detection — live inference, accuracy unverified)'
          : 'flood-ml sidecar (IBM Granite geospatial flood detection — MOCK fixture, not live inference)',
      assessedAt: response.timestamp ?? new Date().toISOString(),
      message: response.message ?? '',
      recommendedActions: response.recommended_actions ?? []
    };
  }
}

export { ProviderConfigError, ProviderHttpError, ProviderRequestError };

/**
 * Builds the configured driver. Default is the stub; FLOOD_ML_DRIVER=http
 * requires FLOOD_ML_URL and fails closed with ProviderConfigError otherwise.
 */
export function createFloodRiskDriver(env: NodeJS.ProcessEnv = process.env): FloodRiskDriver {
  const flag = (env.FLOOD_ML_DRIVER ?? 'stub').toLowerCase();
  if (flag === 'http') {
    const baseUrl = requireEnv('flood-ml', env, ['FLOOD_ML_URL']).replace(/\/+$/, '');
    return new HttpFloodRiskDriver(baseUrl);
  }
  return new StubFloodRiskDriver();
}
