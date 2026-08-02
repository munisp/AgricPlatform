import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { register } from 'prom-client';
import { MetricsService } from '../metrics/metrics.service.js';
import { HttpMetricsInterceptor } from './http-metrics.interceptor.js';

function contextFor(request: Record<string, unknown>, statusCode = 200): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ statusCode })
    })
  } as unknown as ExecutionContext;
}

const handler: CallHandler = { handle: () => of('ok') };

async function routeLabelFor(request: Record<string, unknown>): Promise<string[]> {
  const interceptor = new HttpMetricsInterceptor(new MetricsService());
  const observable = await interceptor.intercept(contextFor(request), handler);
  await new Promise<void>((resolve, reject) =>
    observable.subscribe({ complete: () => resolve(), error: (e: unknown) => reject(e) })
  );
  const metrics = await register.getSingleMetricAsString('http_requests_total');
  return metrics.split('\n').filter((line) => !line.startsWith('#'));
}

describe('HttpMetricsInterceptor route labels', () => {
  it('labels with the parameterized route path, never the concrete URL', async () => {
    const lines = await routeLabelFor({
      method: 'GET',
      originalUrl: '/api/v1/orders/order-12345/status?foo=bar',
      route: { path: '/api/v1/orders/:id/status' }
    });
    expect(lines.some((l) => l.includes('route="/api/v1/orders/:id/status"'))).toBe(true);
    expect(lines.some((l) => l.includes('order-12345'))).toBe(false);
    expect(lines.some((l) => l.includes('originalUrl'))).toBe(false);
  });

  it('falls back to the single unmatched label without a route', async () => {
    const lines = await routeLabelFor({ method: 'GET', originalUrl: '/nope' });
    expect(lines.some((l) => l.includes('route="unmatched"'))).toBe(true);
  });

  it('records the error status for failed requests', async () => {
    const interceptor = new HttpMetricsInterceptor(new MetricsService());
    const failing: CallHandler = {
      handle: () => throwError(() => Object.assign(new Error('teapot'), { status: 418 }))
    };
    const observable = await interceptor.intercept(
      contextFor({ method: 'GET', route: { path: '/api/v1/x' } }),
      failing
    );
    await new Promise<void>((resolve) => observable.subscribe({ error: () => resolve() }));
    const metrics = await register.getSingleMetricAsString('http_requests_total');
    expect(metrics).toContain('status="418"');
    const histogram = await register.getSingleMetricAsString('http_request_duration_seconds');
    expect(histogram).toContain('http_request_duration_seconds_count');
  });
});
