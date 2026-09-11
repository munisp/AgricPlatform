import { context, trace, type Span, type SpanContext } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { describe, expect, it } from 'vitest';
import { telemetryLogMixin } from './log-correlation.js';
import { TenantContext } from './tenant-context.js';

// The NodeSDK installs this context manager in production; tests need it so
// context.with() actually activates the fake spans below.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const VALID_CONTEXT: SpanContext = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  traceFlags: 1
};

function fakeSpan(spanContext: SpanContext): Span {
  return {
    spanContext: () => spanContext
  } as unknown as Span;
}

describe('telemetryLogMixin', () => {
  it('adds nothing when no span is active', () => {
    expect(telemetryLogMixin()).toEqual({});
  });

  it('adds trace_id and span_id when a span is active', () => {
    const ctx = trace.setSpan(context.active(), fakeSpan(VALID_CONTEXT));
    context.with(ctx, () => {
      expect(telemetryLogMixin()).toEqual({
        trace_id: VALID_CONTEXT.traceId,
        span_id: VALID_CONTEXT.spanId
      });
    });
  });

  it('ignores an invalid span context', () => {
    const invalid: SpanContext = {
      traceId: '00000000000000000000000000000000',
      spanId: '0000000000000000',
      traceFlags: 0
    };
    const ctx = trace.setSpan(context.active(), fakeSpan(invalid));
    context.with(ctx, () => {
      expect(telemetryLogMixin()).toEqual({});
    });
  });

  it('adds tenant.id inside a tenant scope (even without a span)', () => {
    TenantContext.runWithTenant('user:u1', () => {
      expect(telemetryLogMixin()).toEqual({ 'tenant.id': 'user:u1' });
    });
  });

  it('combines trace and tenant correlation fields', () => {
    const ctx = trace.setSpan(context.active(), fakeSpan(VALID_CONTEXT));
    TenantContext.runWithTenant('cooperative:coop-1', () => {
      context.with(ctx, () => {
        expect(telemetryLogMixin()).toEqual({
          trace_id: VALID_CONTEXT.traceId,
          span_id: VALID_CONTEXT.spanId,
          'tenant.id': 'cooperative:coop-1'
        });
      });
    });
  });

  it('never throws when the span machinery misbehaves', () => {
    const broken = {
      spanContext: () => {
        throw new Error('broken span');
      }
    } as unknown as Span;
    const ctx = trace.setSpan(context.active(), broken);
    context.with(ctx, () => {
      expect(telemetryLogMixin()).toEqual({});
    });
  });
});
