import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTelemetrySdk,
  initTelemetry,
  parseSamplerRatio,
  resolveTelemetryConfig,
  shutdownTelemetry,
  telemetryActive
} from './telemetry.sdk.js';

afterEach(async () => {
  await shutdownTelemetry();
  vi.restoreAllMocks();
});

describe('parseSamplerRatio', () => {
  it('returns undefined for missing/empty values', () => {
    expect(parseSamplerRatio(undefined)).toBeUndefined();
    expect(parseSamplerRatio('')).toBeUndefined();
    expect(parseSamplerRatio('  ')).toBeUndefined();
  });

  it('parses valid ratios', () => {
    expect(parseSamplerRatio('0.25')).toBe(0.25);
    expect(parseSamplerRatio('1')).toBe(1);
    expect(parseSamplerRatio('0')).toBe(0);
  });

  it('rejects out-of-range and non-numeric values with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseSamplerRatio('1.5')).toBeUndefined();
    expect(parseSamplerRatio('-0.1')).toBeUndefined();
    expect(parseSamplerRatio('abc')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe('resolveTelemetryConfig', () => {
  it('uses documented defaults', () => {
    const config = resolveTelemetryConfig({});
    expect(config.enabled).toBe(true);
    expect(config.endpoint).toBe('http://localhost:4318');
    expect(config.serviceName).toBe('agric-api');
    expect(config.environment).toBe('development');
    expect(config.samplerRatio).toBe(1.0);
    expect(config.serviceVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('disables only on the exact value "false"', () => {
    expect(resolveTelemetryConfig({ OTEL_ENABLED: 'false' }).enabled).toBe(false);
    expect(resolveTelemetryConfig({ OTEL_ENABLED: 'true' }).enabled).toBe(true);
    expect(resolveTelemetryConfig({ OTEL_ENABLED: '0' }).enabled).toBe(true);
  });

  it('honours endpoint and service name overrides', () => {
    const config = resolveTelemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_SERVICE_NAME: 'agric-worker'
    });
    expect(config.endpoint).toBe('http://collector:4318');
    expect(config.serviceName).toBe('agric-worker');
  });

  it('defaults the sampler ratio to 0.1 in production', () => {
    expect(resolveTelemetryConfig({ NODE_ENV: 'production' }).samplerRatio).toBe(0.1);
    expect(resolveTelemetryConfig({ NODE_ENV: 'production' }).environment).toBe('production');
  });

  it('prefers DEPLOYMENT_ENVIRONMENT over NODE_ENV', () => {
    const config = resolveTelemetryConfig({
      DEPLOYMENT_ENVIRONMENT: 'staging',
      NODE_ENV: 'production'
    });
    expect(config.environment).toBe('staging');
    expect(config.samplerRatio).toBe(1.0);
  });

  it('lets OTEL_TRACES_SAMPLER_ARG override the environment default', () => {
    expect(
      resolveTelemetryConfig({ NODE_ENV: 'production', OTEL_TRACES_SAMPLER_ARG: '0.5' })
        .samplerRatio
    ).toBe(0.5);
  });

  it('falls back to the environment default on an invalid sampler arg', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      resolveTelemetryConfig({ NODE_ENV: 'production', OTEL_TRACES_SAMPLER_ARG: 'banana' })
        .samplerRatio
    ).toBe(0.1);
  });
});

describe('initTelemetry', () => {
  it('is a complete no-op when OTEL_ENABLED=false', () => {
    expect(() => initTelemetry({ OTEL_ENABLED: 'false' })).not.toThrow();
    expect(telemetryActive()).toBe(false);
  });

  it('never throws against an unreachable collector and the app keeps working', async () => {
    const env = {
      OTEL_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1', // dead port
      NODE_ENV: 'test'
    };
    expect(() => initTelemetry(env)).not.toThrow();
    expect(telemetryActive()).toBe(true);

    // Application code continues: spans are created/ended without throwing,
    // even though every export will fail (warn-and-continue via diag).
    const span = trace.getTracer('telemetry-spec').startSpan('smoke');
    span.setAttribute('k', 'v');
    span.end();

    // Idempotent: a second init call (boot import + first statement) is a no-op.
    expect(() => initTelemetry(env)).not.toThrow();

    // Shutdown must resolve despite the failed flush to the dead collector.
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    expect(telemetryActive()).toBe(false);
  }, 30_000);

  it('createTelemetrySdk builds a startable SDK for a valid config', async () => {
    const sdk = createTelemetrySdk(resolveTelemetryConfig({ NODE_ENV: 'test' }));
    expect(sdk).toBeDefined();
    // Not started here; shutdown on a never-started SDK is a safe no-op.
    await sdk.shutdown();
  });
});
