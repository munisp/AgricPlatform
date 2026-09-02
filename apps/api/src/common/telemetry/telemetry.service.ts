import { Injectable } from '@nestjs/common';
import {
  context,
  metrics,
  trace,
  SpanStatusCode,
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  type Span,
  type Tracer
} from '@opentelemetry/api';
import { spanAttributes } from './tenant-context.js';

/**
 * App-facing telemetry helpers (integration map §3/§4). Wraps the
 * `@opentelemetry/api` no-op-safe surface: when the SDK is disabled
 * (OTEL_ENABLED=false or init failed) the global tracer/meter are no-op
 * providers, so every helper still works and costs ~nothing. Every method
 * also guards against unexpected provider errors — telemetry must never
 * break application code.
 *
 * All spans/metrics automatically include the `tenant.id` attribute when a
 * TenantContext scope is active (see tenant-context.ts).
 */
@Injectable()
export class TelemetryService {
  private readonly tracer: Tracer = trace.getTracer('agric-api');
  private readonly meter: Meter = metrics.getMeter('agric-api');
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();

  /**
   * Runs `fn` inside a span named `name`. Exceptions raised by `fn` are
   * recorded on the span and re-thrown unchanged; if the span machinery
   * itself fails, `fn` runs uninstrumented.
   */
  async withSpan<T>(
    name: string,
    attributes: Attributes,
    fn: () => Promise<T> | T
  ): Promise<T> {
    const span = this.startSpanSafe(name, attributes);
    if (!span) {
      return fn();
    }
    try {
      const result = await context.with(trace.setSpan(context.active(), span), fn);
      this.setStatusSafe(span, SpanStatusCode.OK);
      return result;
    } catch (error) {
      try {
        span.recordException(error as Error);
        this.setStatusSafe(span, SpanStatusCode.ERROR);
      } catch {
        // swallow: error recording must not mask the original failure
      }
      throw error;
    } finally {
      try {
        span.end();
      } catch {
        // swallow
      }
    }
  }

  /** Increments a counter (created lazily). Never throws. */
  increment(name: string, value = 1, attributes: Attributes = {}): void {
    try {
      this.counterFor(name).add(value, spanAttributes(attributes));
    } catch {
      // swallow
    }
  }

  /** Records a histogram observation (created lazily). Never throws. */
  record(name: string, value: number, attributes: Attributes = {}): void {
    try {
      this.histogramFor(name).record(value, spanAttributes(attributes));
    } catch {
      // swallow
    }
  }

  private startSpanSafe(name: string, attributes: Attributes): Span | null {
    try {
      return this.tracer.startSpan(name, { attributes: spanAttributes(attributes) });
    } catch {
      return null;
    }
  }

  private setStatusSafe(span: Span, code: SpanStatusCode): void {
    try {
      span.setStatus({ code });
    } catch {
      // swallow
    }
  }

  private counterFor(name: string): Counter {
    let counter = this.counters.get(name);
    if (!counter) {
      counter = this.meter.createCounter(name);
      this.counters.set(name, counter);
    }
    return counter;
  }

  private histogramFor(name: string): Histogram {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = this.meter.createHistogram(name);
      this.histograms.set(name, histogram);
    }
    return histogram;
  }
}
