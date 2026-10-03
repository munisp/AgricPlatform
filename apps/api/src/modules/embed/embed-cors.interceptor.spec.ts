import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { configuredCorsOrigins, configuredEmbedOrigins } from '../../common/cors.js';
import { EmbedCorsInterceptor } from './embed-cors.interceptor.js';

function makeContext(origin?: string): {
  context: ExecutionContext;
  headers: Map<string, string>;
} {
  const headers = new Map<string, string>();
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ headers: origin ? { origin } : {} }),
      getResponse: () => ({
        setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value)
      })
    })
  } as unknown as ExecutionContext;
  return { context, headers };
}

const handler: CallHandler = { handle: () => of({ data: [] }) };

describe('configuredCorsOrigins / configuredEmbedOrigins (GAP-L17)', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it('parses the credentialled allowlist with the localhost default', () => {
    delete process.env.CORS_ORIGIN;
    expect(configuredCorsOrigins()).toEqual(['http://localhost:3000']);
    process.env.CORS_ORIGIN = ' https://app.example , https://admin.example ';
    expect(configuredCorsOrigins()).toEqual(['https://app.example', 'https://admin.example']);
  });

  it('embed origins extend (never replace) the credentialled allowlist', () => {
    process.env.CORS_ORIGIN = 'https://app.example';
    process.env.EMBED_CORS_ORIGINS = 'https://partner-site.example, https://coop.example';
    expect(configuredEmbedOrigins()).toEqual([
      'https://app.example',
      'https://partner-site.example',
      'https://coop.example'
    ]);
  });
});

describe('EmbedCorsInterceptor (GAP-L17)', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it('echoes an allowlisted origin with Vary: Origin (never the wildcard)', () => {
    process.env.CORS_ORIGIN = 'https://app.example';
    process.env.EMBED_CORS_ORIGINS = 'https://partner-site.example';
    const { context, headers } = makeContext('https://partner-site.example');
    new EmbedCorsInterceptor().intercept(context, handler);
    expect(headers.get('access-control-allow-origin')).toBe('https://partner-site.example');
    expect(headers.get('access-control-allow-origin')).not.toBe('*');
    expect(headers.get('vary')).toBe('Origin');
  });

  it('fails closed for origins outside the allowlist (no ACAO header)', () => {
    process.env.CORS_ORIGIN = 'https://app.example';
    delete process.env.EMBED_CORS_ORIGINS;
    const { context, headers } = makeContext('https://evil.example');
    new EmbedCorsInterceptor().intercept(context, handler);
    expect(headers.has('access-control-allow-origin')).toBe(false);
  });

  it('sets no ACAO header for non-browser requests without an Origin', () => {
    process.env.CORS_ORIGIN = 'https://app.example';
    const { context, headers } = makeContext(undefined);
    new EmbedCorsInterceptor().intercept(context, handler);
    expect(headers.has('access-control-allow-origin')).toBe(false);
  });
});
