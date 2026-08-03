/**
 * Flood-risk drivers (wave ML): the flood-ml sidecar (services/flood-ml,
 * IBM Granite geospatial flood detection ported from farmer-data-collection)
 * is an OPTIONAL integration. The stub driver stays the default
 * FLOOD_ML_DRIVER so CI and local dev remain deterministic; setting
 * FLOOD_ML_DRIVER=http switches assessments to the sidecar's /predict
 * endpoint (env FLOOD_ML_URL). The factory fails closed with
 * ProviderConfigError when http is selected but the URL is absent — the
 * service maps that (and unreachable sidecars) to a 503 in production.
 */
import {
  httpJson,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  requireEnv
} from '../integrations/drivers/http.js';

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
}

interface FloodMlHealthResponse {
  status?: string;
  sentinel_hub_configured?: boolean;
}

/**
 * Live driver against the flood-ml sidecar. Includes a simple circuit
 * breaker: after FLOOD_ML_CIRCUIT_THRESHOLD consecutive failures the
 * circuit opens for FLOOD_ML_CIRCUIT_COOLDOWN_MS and calls fail fast with
 * ProviderRequestError (checked at call time — no in-process timers).
 */
export class HttpFloodRiskDriver implements FloodRiskDriver {
  readonly name = 'http' as const;

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(private readonly baseUrl: string) {}

  async assess(input: FloodRiskAssessInput): Promise<FloodRiskAssessment> {
    this.assertCircuitClosed();
    try {
      const response = await httpJson<FloodMlPredictResponse>(
        'flood-ml',
        `${this.baseUrl}/predict`,
        { body: { latitude: input.latitude, longitude: input.longitude } }
      );
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
    return {
      floodDetected: response.flood_detected ?? false,
      severity: response.severity ?? 'unknown',
      floodPercentage: response.flood_percentage ?? 0,
      floodAreaKm2: response.flood_area_km2 ?? 0,
      confidence: response.avg_confidence ?? 0,
      source: 'flood-ml sidecar (IBM Granite geospatial flood detection — accuracy unverified)',
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
