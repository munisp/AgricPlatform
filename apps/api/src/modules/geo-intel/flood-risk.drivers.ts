import { randomUUID } from 'node:crypto';
import type { FarmPlot } from '@agric-platform/shared';

/** Environment shape the drivers read (test-seamable). */
export interface FloodMlEnv {
  FLOOD_ML_DRIVER?: string;
  FLOOD_ML_URL?: string;
  FLOOD_ML_TIMEOUT_MS?: string;
  NODE_ENV?: string;
}

export interface FloodAssessmentInput {
  latitude: number;
  longitude: number;
  plot?: FarmPlot;
}

/** Raw sidecar/stub response shape (snake_case at the boundary). */
export interface FloodAssessmentPayload {
  flood_detected: boolean;
  severity: 'none' | 'low' | 'moderate' | 'high' | 'severe';
  flood_percentage?: number;
  flood_area_km2?: number;
  avg_confidence?: number;
  /** Provenance honesty: 'live' = real inference, 'fixture' = simulated. */
  basis: 'live' | 'fixture';
  source?: string;
  [key: string]: unknown;
}

export interface FloodMlDriver {
  name: 'stub' | 'http';
  assess(input: FloodAssessmentInput): Promise<FloodAssessmentPayload>;
}

export type FloodMlFetch = typeof fetch;

/** Fail-closed configuration error (503 at the service layer). */
export const FLOOD_ML_UNCONFIGURED =
  'FLOOD_ML_DRIVER=http requires FLOOD_ML_URL (the flood-ml sidecar base URL)';

export function floodMlUnconfiguredStatus(): {
  configured: boolean;
  detail: string;
} {
  return { configured: false, detail: FLOOD_ML_UNCONFIGURED };
}

const SEVERITIES = new Set(['none', 'low', 'moderate', 'high', 'severe']);

function contractViolation(detail: string): Error {
  return new Error(`malformed /predict response: ${detail}`);
}

/**
 * Validates the sidecar's /predict payload. Fail-closed (audit A3-12): a
 * response that does not satisfy the documented contract
 * (docs/ml/flood-detection.md §API) is an error, never coerced — a degraded
 * model must not silently serve as "no flood".
 */
export function assertValidPrediction(payload: unknown): FloodAssessmentPayload {
  if (!payload || typeof payload !== 'object') {
    throw contractViolation('not an object');
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.flood_detected !== 'boolean') {
    throw contractViolation('flood_detected missing or not boolean');
  }
  if (typeof record.severity !== 'string' || !SEVERITIES.has(record.severity)) {
    throw contractViolation(`severity missing or unknown: ${String(record.severity)}`);
  }
  for (const key of ['flood_percentage', 'flood_area_km2', 'avg_confidence'] as const) {
    const value = record[key];
    if (value !== undefined && (typeof value !== 'number' || Number.isNaN(value))) {
      throw contractViolation(`${key} present but not a number`);
    }
  }
  if (record.basis !== 'live' && record.basis !== 'fixture') {
    throw contractViolation('basis provenance missing (expected live|fixture)');
  }
  return record as FloodAssessmentPayload;
}

/** Default inter-retry sleep; tests substitute fake timers. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded retry with exponential backoff (GAP-M01): one transient sidecar
 * wobble must not 503 the farmer-facing assessment. Attempts:
 * FLOOD_ML_ATTEMPTS (default 3); backoff base FLOOD_ML_RETRY_BASE_MS
 * (default 250ms, doubling per attempt). Only transport/5xx failures retry;
 * contract violations are permanent and fail immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  env: FloodMlEnv,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<T> {
  const attempts = Math.max(1, Number(env.FLOOD_ML_ATTEMPTS ?? 3) || 3);
  const baseMs = Math.max(0, Number(env.FLOOD_ML_RETRY_BASE_MS ?? 250) || 0);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.startsWith('malformed /predict response')) {
        throw error; // permanent contract violation — do not retry
      }
      if (attempt < attempts && baseMs > 0) {
        await sleep(baseMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

/**
 * HTTP driver: posts the assessment to the flood-ml sidecar's /predict
 * endpoint and validates the contract strictly. Construction with a
 * missing URL throws FLOOD_ML_UNCONFIGURED (the service maps it to 503).
 */
export function createHttpDriver(
  env: FloodMlEnv,
  fetchImpl: FloodMlFetch = fetch,
  sleep?: (ms: number) => Promise<void>
): FloodMlDriver {
  const baseUrl = env.FLOOD_ML_URL?.replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error(FLOOD_ML_UNCONFIGURED);
  }
  const timeoutMs = Math.max(1000, Number(env.FLOOD_ML_TIMEOUT_MS ?? 10_000) || 10_000);
  return {
    name: 'http',
    async assess(input) {
      return withRetry(
        async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetchImpl(`${baseUrl}/predict`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                request_id: randomUUID(),
                latitude: input.latitude,
                longitude: input.longitude,
                plot: input.plot
                  ? {
                      id: input.plot.id,
                      centroid_lat: input.plot.centroidLat,
                      centroid_long: input.plot.centroidLong,
                      size_hectares: input.plot.sizeHectares
                    }
                  : undefined
              }),
              signal: controller.signal
            });
            if (!response.ok) {
              throw new Error(`flood-ml sidecar answered ${response.status}`);
            }
            return assertValidPrediction(await response.json());
          } finally {
            clearTimeout(timer);
          }
        },
        env,
        sleep
      );
    }
  };
}

/**
 * Stub driver (default outside production): deterministic FABRICATED
 * fixture, explicitly labelled — never presented as live inference. The
 * service layer refuses to serve it in production (audit A3-11).
 */
export function createStubDriver(): FloodMlDriver {
  return {
    name: 'stub',
    async assess(input) {
      // Deterministic pseudo-assessment keyed by the location, so demos and
      // tests are stable; clearly marked as simulated.
      const seed = Math.abs(Math.sin(input.latitude * 12.9898 + input.longitude * 78.233));
      const floodPercentage = Number((seed * 6).toFixed(2));
      return {
        flood_detected: false,
        severity: 'none',
        flood_percentage: floodPercentage,
        flood_area_km2: 0,
        avg_confidence: 0.5,
        basis: 'fixture',
        source: 'stub-fixture (simulated; no live inference)'
      };
    }
  };
}

/** Selects the configured driver (stub default; http when FLOOD_ML_DRIVER=http). */
export function selectFloodMlDriver(env: FloodMlEnv, fetchImpl?: FloodMlFetch): FloodMlDriver {
  if (env.FLOOD_ML_DRIVER === 'http') {
    return createHttpDriver(env, fetchImpl);
  }
  return createStubDriver();
}

/**
 * Shared assessment orchestration used by the service: runs the driver's
 * assessment and stamps the driver name onto the payload for provenance.
 */
export async function assessFloodRisk(
  env: FloodMlEnv,
  driver: FloodMlDriver,
  input: FloodAssessmentInput
): Promise<FloodAssessmentPayload & { driver: 'stub' | 'http' }> {
  const payload = await driver.assess(input);
  return { ...payload, driver: driver.name };
}
