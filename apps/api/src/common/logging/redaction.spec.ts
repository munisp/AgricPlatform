import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  genReqId,
  isHealthProbe,
  maskPhone,
  redactUrl,
  REDACT_PATHS,
  resolveLogLevel,
  resolveTransport,
  serializers
} from './redaction.js';

function fakeReqRes(headers: Record<string, string> = {}) {
  const req = { headers, url: '/api/v1/auth/otp/request', method: 'POST' } as IncomingMessage;
  const res = new EventEmitter() as ServerResponse;
  const set: Record<string, string> = {};
  res.setHeader = ((name: string, value: string) => {
    set[name.toLowerCase()] = value;
  }) as ServerResponse['setHeader'];
  return { req, res, set };
}

describe('genReqId', () => {
  it('honors an inbound x-request-id and echoes it on the response', () => {
    const { req, res, set } = fakeReqRes({ 'x-request-id': 'req-from-edge-1' });
    const id = genReqId(req, res);
    expect(id).toBe('req-from-edge-1');
    expect(set['x-request-id']).toBe('req-from-edge-1');
  });

  it('generates a uuid when no inbound id is present', () => {
    const { req, res, set } = fakeReqRes();
    const id = genReqId(req, res);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(set['x-request-id']).toBe(id);
  });

  it('uses the first value when the header is an array', () => {
    const { req, res, set } = fakeReqRes();
    req.headers['x-request-id'] = ['first', 'second'];
    expect(genReqId(req, res)).toBe('first');
    expect(set['x-request-id']).toBe('first');
  });
});

describe('maskPhone', () => {
  it('masks Nigerian mobile numbers', () => {
    expect(maskPhone('08031234000')).toBe('0803****000');
  });
  it('returns short/empty input untouched-ish', () => {
    expect(maskPhone(undefined)).toBeUndefined();
    expect(maskPhone('')).toBeUndefined();
    expect(maskPhone('123')).toBe('123');
  });
});

describe('redaction policy', () => {
  it('covers every secret-bearing field', () => {
    for (const path of [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.code',
      'req.body.devCode',
      'req.body.token',
      'req.body.phone',
      'res.body.token',
      'res.body.devCode',
      'res.body.user.phone'
    ]) {
      expect(REDACT_PATHS).toContain(path);
    }
  });

  it('request serializer masks query phone and keeps the request id', () => {
    const req = {
      id: 'req-9',
      method: 'GET',
      url: '/api/v1/users?phone=08031234000',
      query: { phone: '08031234000' }
    } as unknown as Parameters<typeof serializers.req>[0];
    expect(serializers.req(req)).toEqual({
      method: 'GET',
      // Query strings are stripped from the logged URL (Stage 24, A3-4);
      // safe query-derived fields are logged explicitly (masked phone).
      url: '/api/v1/users',
      requestId: 'req-9',
      phone: '0803****000'
    });
  });

  it('request serializer never logs query-string credentials (Stage 24, A3-4)', () => {
    const req = {
      id: 'req-10',
      method: 'POST',
      url: '/api/v1/ussd/callback?token=SUPERSECRET',
      query: { token: 'SUPERSECRET' }
    } as unknown as Parameters<typeof serializers.req>[0];
    const serialized = serializers.req(req);
    expect(serialized.url).toBe('/api/v1/ussd/callback');
    expect(JSON.stringify(serialized)).not.toContain('SUPERSECRET');
  });
});

describe('redactUrl (Stage 24, A3-4)', () => {
  it('strips the query string and tolerates missing/empty urls', () => {
    expect(redactUrl('/api/v1/ussd/callback?token=x&sessionId=1')).toBe('/api/v1/ussd/callback');
    expect(redactUrl('/api/v1/orders')).toBe('/api/v1/orders');
    expect(redactUrl(undefined)).toBeUndefined();
  });
});

describe('health probe quieting', () => {
  it('ignores health endpoints only', () => {
    expect(isHealthProbe({ url: '/api/v1/health/ready' } as IncomingMessage)).toBe(true);
    expect(isHealthProbe({ url: '/api/v1/health' } as IncomingMessage)).toBe(true);
    expect(isHealthProbe({ url: '/api/v1/orders' } as IncomingMessage)).toBe(false);
    expect(isHealthProbe({} as IncomingMessage)).toBe(false);
  });
});

describe('level + transport resolution', () => {
  it('level: LOG_LEVEL wins, then env default', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'warn' } as NodeJS.ProcessEnv)).toBe('warn');
    expect(resolveLogLevel({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe('info');
    expect(resolveLogLevel({} as NodeJS.ProcessEnv)).toBe('debug');
  });

  it('pretty transport only behind LOG_PRETTY=1', () => {
    expect(resolveTransport({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveTransport({ LOG_PRETTY: '0' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveTransport({ LOG_PRETTY: '1' } as NodeJS.ProcessEnv)?.target).toBe('pino-pretty');
  });
});
