/**
 * Shared driver-health primitives (Stage 27, WP-G10 telemetry gaps): one
 * vocabulary for circuit-breaker state, last-error classification and
 * last-success timestamps across the infra drivers, so the readiness
 * registry (health/infra-driver-registry.ts) can aggregate the event-bus,
 * orchestrator, authz, ledger and search drivers without per-driver shape
 * drift. Pure helpers — no framework imports, no I/O.
 */
import {
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError
} from './http.js';

/** Circuit-breaker state labels exposed on driver status reports. */
export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

/**
 * Derives the breaker label from the platform's standard call-time breaker
 * fields (see the workflow-orchestrator/tigerbeetle/event-bus drivers):
 * `failures` consecutive failures against `threshold`, with the circuit
 * held open until `openUntil` (epoch ms). Once the cooldown expires the
 * next call is the half-open probe — the pattern has no explicit half-open
 * flag, so the label is derived.
 */
export function circuitBreakerState(
  failures: number,
  threshold: number,
  openUntil: number,
  now: number = Date.now()
): CircuitBreakerState {
  if (failures < threshold) {
    return 'closed';
  }
  return now < openUntil ? 'open' : 'half-open';
}

/**
 * Error-class vocabulary for `lastErrorClass` on driver status reports.
 * Deliberately coarse — the class feeds dashboards and readiness reasons,
 * not debugging (the full error stays in logs/traces).
 */
export type DriverErrorClass =
  | 'timeout'
  | 'network'
  | 'http-4xx'
  | 'http-5xx'
  | 'config'
  | 'internal';

/** Classifies a driver failure into the shared error-class vocabulary. */
export function classifyDriverError(error: unknown): DriverErrorClass {
  if (error instanceof ProviderRequestError) {
    return error.reason;
  }
  if (error instanceof ProviderHttpError) {
    return error.status >= 500 ? 'http-5xx' : 'http-4xx';
  }
  if (error instanceof ProviderConfigError) {
    return 'config';
  }
  return 'internal';
}

/**
 * Optional health fields mixed into each driver's status report. Optional
 * so test fakes implementing the driver ports keep compiling; every real
 * driver populates them (circuitBreaker only where a breaker exists).
 */
export interface DriverHealthFields {
  circuitBreaker?: CircuitBreakerState;
  lastErrorClass?: DriverErrorClass | null;
  lastSuccessAt?: string | null;
}

/**
 * Mutable per-driver tracker for the status() accessor: records the class
 * of the most recent failure and the timestamp of the most recent success.
 * Drivers call recordSuccess/recordError from their existing
 * recordSuccess/recordFailure breaker hooks, so the tracking can never
 * change call-path behaviour.
 */
export class DriverHealthTracker {
  private errorClass: DriverErrorClass | null = null;
  private errorAtMs: number | null = null;
  private successAtMs: number | null = null;

  recordSuccess(now: number = Date.now()): void {
    this.successAtMs = now;
  }

  recordError(error: unknown, now: number = Date.now()): void {
    this.errorClass = classifyDriverError(error);
    this.errorAtMs = now;
  }

  /** Class of the most recent failure, or null when none has occurred. */
  get lastErrorClass(): DriverErrorClass | null {
    return this.errorClass;
  }

  /** ISO timestamp of the most recent failure, or null when none yet. */
  get lastErrorAt(): string | null {
    return this.errorAtMs === null ? null : new Date(this.errorAtMs).toISOString();
  }

  /** ISO timestamp of the most recent success, or null when none yet. */
  get lastSuccessAt(): string | null {
    return this.successAtMs === null ? null : new Date(this.successAtMs).toISOString();
  }

  /**
   * True when the most recent tracked outcome is a failure — failure
   * evidence for the readiness registry. Clears on the next success.
   */
  get failing(): boolean {
    return this.errorAtMs !== null &&
      (this.successAtMs === null || this.errorAtMs > this.successAtMs);
  }
}
