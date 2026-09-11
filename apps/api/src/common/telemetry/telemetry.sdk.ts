import { createRequire } from 'node:module';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { KafkaJsInstrumentation } from '@opentelemetry/instrumentation-kafkajs';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';

/**
 * OpenTelemetry SDK bootstrap (integration map §1).
 *
 * FAIL-SAFE DOCTRINE: telemetry is observability, not a money path. Nothing
 * in this module ever throws — a missing/unreachable collector, a bad env
 * value, or an incompatible instrumentation is a logged warning and the app
 * continues without (or with partial) telemetry. There are deliberately NO
 * production boot-fatal assertions for OTEL_* env vars.
 *
 * `initTelemetry()` is invoked by `telemetry.boot.ts`, the first import in
 * `main.ts`, so auto-instrumentation hooks `http`/`express`/`pg`/`ioredis`/
 * `kafkajs` before the Nest application modules load them.
 */

export interface TelemetryConfig {
  enabled: boolean;
  endpoint: string;
  serviceName: string;
  serviceVersion: string;
  environment: string;
  /** Root trace sampling ratio in [0, 1]. */
  samplerRatio: number;
}

const DEFAULT_ENDPOINT = 'http://localhost:4318';
const DEFAULT_SERVICE_NAME = 'agric-api';
const PROD_SAMPLER_RATIO = 0.1;

function warn(message: string): void {
  // pino is not bound yet at this stage of boot; console is the safest sink.
  console.warn(`[telemetry] ${message}`);
}

/**
 * Parses OTEL_TRACES_SAMPLER_ARG. Returns undefined (caller falls back to the
 * environment default) for missing or out-of-range values; never throws.
 */
export function parseSamplerRatio(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const ratio = Number(raw);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    warn(`invalid OTEL_TRACES_SAMPLER_ARG "${raw}" (expected 0..1); using the environment default`);
    return undefined;
  }
  return ratio;
}

/** Reads the api package version for the service.version resource attribute. */
function resolveServiceVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Pure config builder — unit-tested directly, no side effects. */
export function resolveTelemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const environment = env.DEPLOYMENT_ENVIRONMENT ?? env.NODE_ENV ?? 'development';
  const samplerRatio =
    parseSamplerRatio(env.OTEL_TRACES_SAMPLER_ARG) ??
    (environment === 'production' ? PROD_SAMPLER_RATIO : 1.0);
  return {
    enabled: env.OTEL_ENABLED !== 'false',
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_ENDPOINT,
    serviceName: env.OTEL_SERVICE_NAME ?? DEFAULT_SERVICE_NAME,
    serviceVersion: resolveServiceVersion(),
    environment,
    samplerRatio
  };
}

function expressAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('express');
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the instrumentation set. Each instrumentation is constructed behind
 * its own try/catch so an incompatible one degrades to a warning and is
 * skipped instead of breaking the whole pipeline. Load-time patch failures
 * surface through the diag logger (installed in initTelemetry) as warnings.
 */
export function buildInstrumentations(): Instrumentation[] {
  const instrumentations: Instrumentation[] = [];
  const add = (name: string, create: () => Instrumentation): void => {
    try {
      instrumentations.push(create());
    } catch (error) {
      warn(`instrumentation "${name}" skipped: ${(error as Error).message}`);
    }
  };

  add('http', () => new HttpInstrumentation());
  if (expressAvailable()) {
    add('express', () => new ExpressInstrumentation());
  }
  add('pg', () => new PgInstrumentation());
  add('ioredis', () => new IORedisInstrumentation());
  add('kafkajs', () => new KafkaJsInstrumentation());
  // Node >= 18 exposes a global undici-based fetch; guard for runtimes where
  // it is absent so the instrumentation is simply skipped there.
  if (typeof globalThis.fetch === 'function') {
    add('fetch/undici', () => new UndiciInstrumentation());
  }

  return instrumentations;
}

let activeSdk: NodeSDK | null = null;
let diagLoggerInstalled = false;

export function telemetryActive(): boolean {
  return activeSdk !== null;
}

/**
 * Starts the NodeSDK with OTLP HTTP/protobuf trace + metric exporters.
 * Idempotent and never throws; an unreachable collector only produces export
 * warnings later (BatchSpanProcessor / PeriodicExportingMetricReader absorb
 * and report them through the diag logger).
 */
export function initTelemetry(env: NodeJS.ProcessEnv = process.env): void {
  if (activeSdk) {
    return; // already initialised (boot import + explicit first statement)
  }
  const config = resolveTelemetryConfig(env);
  if (!config.enabled) {
    return; // OTEL_ENABLED=false: complete no-op
  }
  try {
    if (!diagLoggerInstalled) {
      // Route SDK-internal errors (e.g. unreachable collector on export) to
      // warnings instead of letting them surface as unhandled errors.
      diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
      diagLoggerInstalled = true;
    }
    activeSdk = createTelemetrySdk(config);
    activeSdk.start();
    process.once('SIGTERM', () => {
      void shutdownTelemetry();
    });
  } catch (error) {
    warn(`init failed; continuing without telemetry: ${(error as Error).message}`);
    activeSdk = null;
  }
}

/** Creates (but does not start) the SDK — separated for testability. */
export function createTelemetrySdk(config: TelemetryConfig): NodeSDK {
  return new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': config.serviceName,
      'service.version': config.serviceVersion,
      'deployment.environment': config.environment
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.samplerRatio)
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${config.endpoint}/v1/traces`
    }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${config.endpoint}/v1/metrics`
        })
      })
    ],
    instrumentations: buildInstrumentations()
  });
}

/** Flushes and shuts down the SDK. Never throws. */
export async function shutdownTelemetry(): Promise<void> {
  const sdk = activeSdk;
  activeSdk = null;
  if (!sdk) {
    return;
  }
  try {
    await sdk.shutdown();
  } catch (error) {
    warn(`shutdown failed: ${(error as Error).message}`);
  }
}
