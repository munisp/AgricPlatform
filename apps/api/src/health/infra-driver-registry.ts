/**
 * Infra-driver readiness registry (Stage 27, WP-G10 telemetry gaps).
 * Aggregates the platform's middleware drivers — event bus (stub | kafka |
 * fluvio), workflow orchestrator (stub | temporal), authorization check
 * (stub | permify) — behind one uniform status shape for /health/ready:
 *
 *   - port / driver:    the logical port and the selected implementation
 *   - enabled:          a live external driver is selected (not the stub)
 *   - state:            'ok' | 'degraded' | 'disabled'
 *   - circuitBreaker:   'closed' | 'open' | 'half-open' where a breaker
 *                       exists (platform pattern: 3 consecutive failures
 *                       open the circuit for 30s, then a half-open probe)
 *   - lastErrorClass / lastSuccessAt: from the driver's health tracker
 *
 * DEGRADED-NOT-DOWN DOCTRINE: every driver on this registry is OPTIONAL —
 * a degraded driver never fails readiness, it is listed in the response's
 * degraded[] array with its reason. Only the REQUIRED persistence drivers
 * (postgres, redis — see dependency-indicator.ts) fail /health/ready. A
 * stub/unconfigured driver reports 'disabled', never 'down' (fail-closed
 * doctrine: the factories refuse boot for a misconfigured live driver, so
 * anything running is either deliberately disabled or correctly wired).
 *
 * Degradation evidence: the lazy drivers connect on first use, so
 * "configured but never connected" is a normal idle state, NOT a failure.
 * A driver is degraded only with failure evidence — an open circuit or a
 * most-recent-outcome failure recorded by its health tracker.
 */
import type { AuthorizationCheck } from '../common/auth/authorization-check.driver.js';
import type { WorkflowOrchestrator } from '../common/orchestration/workflow-orchestrator.driver.js';
import type { EventBus } from '../core/events/event-bus.driver.js';
import {
  classifyDriverError,
  type DriverErrorClass,
  type DriverHealthFields
} from '../modules/integrations/drivers/driver-health.js';

/** Injection token for the driver probe registry (multi-provider). */
export const INFRA_DRIVER_PROBES = 'INFRA_DRIVER_PROBES';

export type InfraDriverState = 'ok' | 'degraded' | 'disabled';

/** Uniform per-driver status row in the /health/ready response. */
export interface InfraDriverStatus {
  /** Logical port, e.g. 'event-bus' | 'orchestrator' | 'authz'. */
  port: string;
  /** Selected implementation, e.g. 'stub' | 'kafka' | 'temporal' | 'permify'. */
  driver: string;
  /** True when a live external driver is selected (not the in-process stub). */
  enabled: boolean;
  state: InfraDriverState;
  detail: string;
  circuitBreaker?: DriverHealthFields['circuitBreaker'];
  lastErrorClass: DriverErrorClass | null;
  lastSuccessAt: string | null;
}

/** The driver surface the registry probes (all driver ports expose it). */
export interface StatusedDriver {
  readonly name: string;
  status(): Promise<
    { configured: boolean; healthy: boolean; detail: string } & DriverHealthFields
  >;
}

/** A registry entry: one logical port bound to its selected driver. */
export interface InfraDriverProbe {
  readonly port: string;
  readonly driver: StatusedDriver;
}

/** Degraded-driver entry in the /health/ready response. */
export interface DegradedDriver {
  name: string;
  reason: string;
}

/** Maps a driver's status() report onto the uniform registry row. */
function toDriverStatus(
  probe: InfraDriverProbe,
  status: { configured: boolean; healthy: boolean; detail: string } & DriverHealthFields
): InfraDriverStatus {
  const enabled = probe.driver.name !== 'stub';
  const failureEvidence =
    status.circuitBreaker === 'open' || status.lastErrorClass != null;
  const state: InfraDriverState =
    !enabled || !status.configured
      ? 'disabled'
      : status.healthy || !failureEvidence
        ? 'ok'
        : 'degraded';
  return {
    port: probe.port,
    driver: probe.driver.name,
    enabled,
    state,
    detail: status.detail,
    ...(status.circuitBreaker !== undefined
      ? { circuitBreaker: status.circuitBreaker }
      : {}),
    lastErrorClass: status.lastErrorClass ?? null,
    lastSuccessAt: status.lastSuccessAt ?? null
  };
}

/**
 * Probes every registered driver. A driver whose status() call itself
 * throws is reported 'degraded' with the classified error — the probe must
 * never break the readiness endpoint.
 */
export async function evaluateInfraDrivers(
  probes: InfraDriverProbe[]
): Promise<InfraDriverStatus[]> {
  return Promise.all(
    probes.map(async (probe) => {
      try {
        return toDriverStatus(probe, await probe.driver.status());
      } catch (error) {
        return {
          port: probe.port,
          driver: probe.driver.name,
          enabled: probe.driver.name !== 'stub',
          state: 'degraded' as const,
          detail: 'Driver status probe failed; see service logs.',
          lastErrorClass: classifyDriverError(error),
          lastSuccessAt: null
        };
      }
    })
  );
}

/** The degraded subset, rendered for the readiness degraded[] array. */
export function degradedDrivers(statuses: InfraDriverStatus[]): DegradedDriver[] {
  return statuses
    .filter((status) => status.state === 'degraded')
    .map((status) => ({
      name: status.port,
      reason: `${status.driver}: ${status.detail}`
    }));
}

/** Probe adapter for the event-bus port (stub | kafka | fluvio). */
export function eventBusProbe(bus: EventBus): InfraDriverProbe {
  return { port: 'event-bus', driver: bus };
}

/** Probe adapter for the workflow-orchestrator port (stub | temporal). */
export function orchestratorProbe(orchestrator: WorkflowOrchestrator): InfraDriverProbe {
  return { port: 'orchestrator', driver: orchestrator };
}

/** Probe adapter for the authorization-check port (stub | permify). */
export function authzProbe(authz: AuthorizationCheck): InfraDriverProbe {
  return { port: 'authz', driver: authz };
}
