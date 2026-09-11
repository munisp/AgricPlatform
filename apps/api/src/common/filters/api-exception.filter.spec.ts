import { ArgumentsHost, BadGatewayException, BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { register } from 'prom-client';
import { MetricsService } from '../metrics/metrics.service.js';
import { ApiExceptionFilter, resolveRequestId } from './api-exception.filter.js';

function hostFor(request: Record<string, unknown>) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return {
    host: {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ status })
      })
    } as unknown as ArgumentsHost,
    json,
    status
  };
}

async function errorCounterValue(): Promise<number> {
  const text = await register.getSingleMetricAsString('agric_errors_5xx_total');
  const line = text.split('\n').find((l) => l.startsWith('agric_errors_5xx_total'));
  return line ? Number(line.split(' ').pop()) : 0;
}

describe('resolveRequestId', () => {
  it('prefers the pino request id, then the header', () => {
    expect(resolveRequestId({ id: 'pino-1', headers: {} } as never)).toBe('pino-1');
    expect(
      resolveRequestId({ headers: { 'x-request-id': 'hdr-1' } } as never)
    ).toBe('hdr-1');
    expect(resolveRequestId({ headers: {} } as never)).toBeUndefined();
  });
});

describe('ApiExceptionFilter', () => {
  it('adds requestId to the error envelope', () => {
    const filter = new ApiExceptionFilter();
    const { host, json, status } = hostFor({
      id: 'req-abc',
      method: 'GET',
      originalUrl: '/api/v1/x',
      headers: {}
    });
    filter.catch(new BadRequestException('bad input'), host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0]).toMatchObject({
      statusCode: 400,
      message: 'bad input',
      requestId: 'req-abc'
    });
  });

  it('counts 5xx on agric_errors_5xx_total but not 4xx', async () => {
    const metrics = new MetricsService();
    const filter = new ApiExceptionFilter(metrics);
    const before = await errorCounterValue();

    const server = hostFor({ method: 'GET', originalUrl: '/api/v1/boom', headers: {} });
    filter.catch(new Error('boom'), server.host);
    expect(await errorCounterValue()).toBe(before + 1);

    const client = hostFor({ method: 'GET', originalUrl: '/api/v1/x', headers: {} });
    filter.catch(new BadRequestException('nope'), client.host);
    expect(await errorCounterValue()).toBe(before + 1);
  });

  it('reports only 5xx to error tracking', () => {
    const capture5xx = vi.fn();
    const filter = new ApiExceptionFilter(new MetricsService(), { capture5xx } as never);

    const server = hostFor({ method: 'GET', originalUrl: '/api/v1/boom', headers: {}, id: 'r1' });
    filter.catch(new Error('boom'), server.host);
    expect(capture5xx).toHaveBeenCalledTimes(1);
    expect(capture5xx.mock.calls[0][1]).toMatchObject({ status: 500, requestId: 'r1' });

    const client = hostFor({ method: 'GET', originalUrl: '/api/v1/x', headers: {} });
    filter.catch(new BadRequestException('nope'), client.host);
    expect(capture5xx).toHaveBeenCalledTimes(1);
  });

  it('never echoes upstream provider error bodies in 5xx envelopes (audit A3-7)', () => {
    const filter = new ApiExceptionFilter();
    // BadGatewayException wrapping a ProviderHttpError-style message: the
    // provider body (account details, internal refs) must not reach the
    // client — it belongs in server logs/Sentry only.
    const providerBody =
      "Provider 'paystack' request failed with HTTP 500: {\"account\":\"0123456789\",\"ref\":\"internal-42\"}";
    const { host, json, status } = hostFor({
      method: 'POST',
      originalUrl: '/api/v1/marketplace/escrow/release',
      headers: {},
      id: 'req-5xx'
    });
    filter.catch(new BadGatewayException(providerBody), host);
    expect(status).toHaveBeenCalledWith(502);
    const envelope = json.mock.calls[0][0];
    expect(envelope.statusCode).toBe(502);
    expect(envelope.message).toBe('Unexpected server error');
    expect(JSON.stringify(envelope)).not.toContain('0123456789');
    expect(JSON.stringify(envelope)).not.toContain('internal-42');
    expect(JSON.stringify(envelope)).not.toContain('paystack');
    // Correlation survives: support can still trace the internal log line.
    expect(envelope.requestId).toBe('req-5xx');
  });

  it('keeps 4xx messages verbatim (client-actionable)', () => {
    const filter = new ApiExceptionFilter();
    const { host, json } = hostFor({ method: 'GET', originalUrl: '/api/v1/x', headers: {} });
    filter.catch(new BadRequestException('lat must be between -90 and 90'), host);
    expect(json.mock.calls[0][0].message).toBe('lat must be between -90 and 90');
  });
});
