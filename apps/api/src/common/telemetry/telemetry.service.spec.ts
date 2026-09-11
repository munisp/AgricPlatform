import { metrics, trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_ATTRIBUTE, TenantContext } from './tenant-context.js';
import { TelemetryService } from './telemetry.service.js';

/**
 * Registers real (in-memory) OTel providers so span/metric behavior is
 * observable. The no-op path (no SDK registered) is covered implicitly: the
 * first test runs before any provider is installed, and `@opentelemetry/api`
 * is a pass-through no-op until then.
 */
describe('TelemetryService', () => {
  it('withSpan runs the function even with no SDK registered (no-op safe)', async () => {
    const service = new TelemetryService();
    await expect(service.withSpan('noop', {}, () => 'done')).resolves.toBe('done');
    expect(() => service.increment('spec.counter')).not.toThrow();
    expect(() => service.record('spec.histogram', 1.5)).not.toThrow();
  });

  describe('with in-memory providers', () => {
    const spanExporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)]
    });
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60_000 // never auto-exports during the test
    });
    const meterProvider = new MeterProvider({ readers: [metricReader] });
    // Registered in beforeAll (not at suite definition) so the "no SDK"
    // test above genuinely runs against the no-op OTel API.
    beforeAll(() => {
      trace.setGlobalTracerProvider(tracerProvider);
      metrics.setGlobalMeterProvider(meterProvider);
    });

    afterAll(async () => {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    });

    it('withSpan records a span with attributes and tenant.id', async () => {
      const service = new TelemetryService();
      const result = await TenantContext.runWithTenant('user:u1', () =>
        service.withSpan('ledger.post', { provider: 'tigerbeetle' }, async () => 'ok')
      );
      expect(result).toBe('ok');
      const spans = spanExporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe('ledger.post');
      expect(spans[0].attributes['provider']).toBe('tigerbeetle');
      expect(spans[0].attributes[TENANT_ATTRIBUTE]).toBe('user:u1');
      expect(spans[0].status.code).toBe(1); // SpanStatusCode.OK
    });

    it('withSpan records the exception and re-throws unchanged', async () => {
      const service = new TelemetryService();
      const failure = new Error('provider timeout');
      await expect(
        service.withSpan('mojaloop.quote', {}, () => {
          throw failure;
        })
      ).rejects.toBe(failure);
      const spans = spanExporter.getFinishedSpans();
      const failed = spans.find((span) => span.name === 'mojaloop.quote');
      expect(failed?.status.code).toBe(2); // SpanStatusCode.ERROR
      expect(failed?.events.some((event) => event.name === 'exception')).toBe(true);
    });

    it('counter and histogram helpers record metrics with tenant attribution', async () => {
      const service = new TelemetryService();
      await TenantContext.runWithTenant('cooperative:coop-1', async () => {
        service.increment('agric.outbox.published', 2);
        service.record('agric.outbox.lag_seconds', 3.5);
      });
      await meterProvider.forceFlush();
      const exported = metricExporter.getMetrics();
      expect(exported.length).toBeGreaterThan(0);
      const resourceMetrics = exported[exported.length - 1];
      const metricsByName = new Map(
        resourceMetrics.scopeMetrics
          .flatMap((scope) => scope.metrics)
          .map((metric) => [metric.descriptor.name, metric])
      );
      const counter = metricsByName.get('agric.outbox.published');
      expect(counter).toBeDefined();
      const counterPoints = (counter as unknown as { dataPoints: Array<{ value: number; attributes: Record<string, unknown> }> }).dataPoints;
      expect(counterPoints[0]?.value).toBe(2);
      expect(counterPoints[0]?.attributes[TENANT_ATTRIBUTE]).toBe('cooperative:coop-1');
      expect(metricsByName.has('agric.outbox.lag_seconds')).toBe(true);
    });
  });
});
