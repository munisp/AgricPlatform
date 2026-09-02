import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { context, trace, type Span, type SpanContext } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { lastValueFrom, Observable } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  deriveTenantId,
  spanAttributes,
  TENANT_ATTRIBUTE,
  TenantAttributionInterceptor,
  TenantContext
} from './tenant-context.js';

// The NodeSDK installs this context manager in production; tests need it so
// context.with() actually activates the fake spans below.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const VALID_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const VALID_SPAN_ID = 'b7ad6b7169203331';

/** Minimal Span stub recording setAttribute calls; used as the active span. */
function recordingSpan(): Span & { attributes: Record<string, unknown> } {
  const attributes: Record<string, unknown> = {};
  const spanContext: SpanContext = {
    traceId: VALID_TRACE_ID,
    spanId: VALID_SPAN_ID,
    traceFlags: 1
  };
  const span = {
    attributes,
    spanContext: () => spanContext,
    setAttribute(key: string, value: unknown) {
      attributes[key] = value;
      return span;
    },
    setAttributes(values: Record<string, unknown>) {
      Object.assign(attributes, values);
      return span;
    },
    addEvent: () => span,
    addLink: () => span,
    addLinks: () => span,
    setStatus: () => span,
    updateName: () => span,
    end: () => undefined,
    isRecording: () => true,
    recordException: () => undefined
  };
  return span as unknown as Span & { attributes: Record<string, unknown> };
}

function httpContext(request: unknown): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) })
  } as unknown as ExecutionContext;
}

describe('TenantContext', () => {
  it('is undefined outside any scope', () => {
    expect(TenantContext.currentTenantId()).toBeUndefined();
  });

  it('propagates the tenant id synchronously and across awaits', async () => {
    const seen: Array<string | undefined> = [];
    await TenantContext.runWithTenant('user:u1', async () => {
      seen.push(TenantContext.currentTenantId());
      await new Promise((resolve) => setImmediate(resolve));
      seen.push(TenantContext.currentTenantId());
    });
    expect(seen).toEqual(['user:u1', 'user:u1']);
    expect(TenantContext.currentTenantId()).toBeUndefined();
  });

  it('supports nested scopes and restores the outer scope', () => {
    TenantContext.runWithTenant('outer', () => {
      expect(TenantContext.currentTenantId()).toBe('outer');
      TenantContext.runWithTenant('inner', () => {
        expect(TenantContext.currentTenantId()).toBe('inner');
      });
      expect(TenantContext.currentTenantId()).toBe('outer');
    });
  });

  it('does not leak across independent async scopes', async () => {
    const [a, b] = await Promise.all([
      TenantContext.runWithTenant('user:a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return TenantContext.currentTenantId();
      }),
      TenantContext.runWithTenant('user:b', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return TenantContext.currentTenantId();
      })
    ]);
    expect([a, b]).toEqual(['user:a', 'user:b']);
  });
});

describe('deriveTenantId', () => {
  it('uses the partner client id for partner callers', () => {
    expect(deriveTenantId({ partner: { clientId: 'acme-corp' } })).toBe('acme-corp');
  });

  it('prefers the partner identity when both are present', () => {
    expect(
      deriveTenantId({ partner: { clientId: 'acme-corp' }, user: { id: 'u1' } })
    ).toBe('acme-corp');
  });

  it('uses the cooperative id when present on the user record', () => {
    expect(deriveTenantId({ user: { id: 'u1', cooperativeId: 'coop-9' } })).toBe(
      'cooperative:coop-9'
    );
  });

  it('uses the programme id when present on the user record', () => {
    expect(deriveTenantId({ user: { id: 'u1', programmeId: 'prog-3' } })).toBe(
      'programme:prog-3'
    );
  });

  it('falls back to user:<id> for plain member users', () => {
    expect(deriveTenantId({ user: { id: 'u1' } })).toBe('user:u1');
  });

  it('returns anonymous without an identity', () => {
    expect(deriveTenantId({})).toBe('anonymous');
    expect(deriveTenantId(undefined)).toBe('anonymous');
    expect(deriveTenantId({ user: {} })).toBe('anonymous');
    expect(deriveTenantId({ partner: { clientId: '' }, user: { id: '' } })).toBe('anonymous');
  });
});

describe('spanAttributes', () => {
  it('includes the tenant id inside a tenant scope', () => {
    TenantContext.runWithTenant('user:u1', () => {
      expect(spanAttributes({ provider: 'mojaloop' })).toEqual({
        provider: 'mojaloop',
        [TENANT_ATTRIBUTE]: 'user:u1'
      });
    });
  });

  it('omits the tenant id outside a scope and never mutates the input', () => {
    const extra = { provider: 'mojaloop' };
    expect(spanAttributes(extra)).toEqual({ provider: 'mojaloop' });
    expect(extra).toEqual({ provider: 'mojaloop' });
  });
});

describe('TenantAttributionInterceptor', () => {
  const interceptor = new TenantAttributionInterceptor();

  function interceptAndCapture(request: unknown): {
    seenTenant: () => string | undefined;
    result: Promise<unknown>;
  } {
    let seenTenant: string | undefined;
    const next: CallHandler = {
      handle: () =>
        new Observable((subscriber) => {
          seenTenant = TenantContext.currentTenantId();
          subscriber.next('ok');
          subscriber.complete();
        })
    };
    const result = lastValueFrom(interceptor.intercept(httpContext(request), next));
    return { seenTenant: () => seenTenant, result };
  }

  it('runs the handler inside the tenant scope for member users', async () => {
    const { seenTenant, result } = interceptAndCapture({ user: { id: 'u1' } });
    await expect(result).resolves.toBe('ok');
    expect(seenTenant()).toBe('user:u1');
    expect(TenantContext.currentTenantId()).toBeUndefined();
  });

  it('attributes partner callers by partner client id', async () => {
    const { seenTenant, result } = interceptAndCapture({
      partner: { clientId: 'acme-corp', scopes: [], sandbox: true }
    });
    await expect(result).resolves.toBe('ok');
    expect(seenTenant()).toBe('acme-corp');
  });

  it('attributes unauthenticated requests as anonymous', async () => {
    const { seenTenant, result } = interceptAndCapture({});
    await expect(result).resolves.toBe('ok');
    expect(seenTenant()).toBe('anonymous');
  });

  it('keeps the tenant scope across async handler work', async () => {
    let seenTenant: string | undefined;
    const next: CallHandler = {
      handle: () =>
        new Observable((subscriber) => {
          void (async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            seenTenant = TenantContext.currentTenantId();
            subscriber.next('ok');
            subscriber.complete();
          })();
        })
    };
    await lastValueFrom(
      interceptor.intercept(httpContext({ user: { id: 'u7' } }), next)
    );
    expect(seenTenant).toBe('user:u7');
  });

  it('stamps tenant.id on the active span', async () => {
    const span = recordingSpan();
    const ctx = trace.setSpan(context.active(), span);
    await context.with(ctx, async () => {
      const { result } = interceptAndCapture({ user: { id: 'u1' } });
      await result;
    });
    expect(span.attributes[TENANT_ATTRIBUTE]).toBe('user:u1');
  });

  it('does not fail when no span is active', async () => {
    const { result } = interceptAndCapture({ user: { id: 'u1' } });
    await expect(result).resolves.toBe('ok');
  });

  it('passes non-HTTP contexts through without a tenant scope', async () => {
    let seenTenant: string | undefined = 'unset';
    const rpcContext = {
      getType: () => 'rpc',
      switchToHttp: () => {
        throw new Error('no http context');
      }
    } as unknown as ExecutionContext;
    const next: CallHandler = {
      handle: () =>
        new Observable((subscriber) => {
          seenTenant = TenantContext.currentTenantId();
          subscriber.next('ok');
          subscriber.complete();
        })
    };
    await lastValueFrom(interceptor.intercept(rpcContext, next));
    expect(seenTenant).toBeUndefined();
  });
});
