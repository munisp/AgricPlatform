import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isProduction } from '../auth/auth.config.js';

/**
 * Log redaction policy (observability plan section A.2). Centralised here so
 * the rules are unit-testable without booting Nest.
 *
 * Never logged: OTP codes (`code`, `devCode`), session/webhook tokens,
 * authorization/cookie/x-api-key headers. Phone numbers are masked
 * (`0803****000`) rather than logged in full (NDPR/NDPA).
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.body.code',
  'req.body.devCode',
  'req.body.token',
  'req.body.phone',
  'res.body.token',
  'res.body.devCode',
  'res.body.user.phone'
];

export const REDACT_CENSOR = '[redacted]';

/** Masks a Nigerian-style phone number: 08031234000 -> 0803****000. */
export function maskPhone(phone?: string): string | undefined {
  if (!phone) {
    return undefined;
  }
  return phone.replace(/^(\d{4})\d+(\d{3})$/, '$1****$2');
}

/** Minimal request shape the serializer needs (pino-http attaches `id`). */
export interface RequestLike {
  id?: string | number;
  url?: string;
  method?: string;
  query?: Record<string, unknown>;
}

/**
 * pino-http request-id generator: honors an inbound `x-request-id` header
 * (so traces propagate from the edge/proxy) and always echoes the id back on
 * the response so clients can quote it in support requests.
 */
export function genReqId(req: IncomingMessage, res: ServerResponse): string {
  const header = req.headers['x-request-id'];
  const id = (Array.isArray(header) ? header[0] : header) || randomUUID();
  res.setHeader('x-request-id', id);
  return id;
}

/** Serializers keep request/response logs low-noise and free of secrets. */
export const serializers = {
  req: (req: RequestLike) => ({
    method: req.method,
    url: req.url,
    requestId: req.id,
    phone: maskPhone(req.query?.phone as string | undefined)
  }),
  res: (res: ServerResponse & { statusCode?: number }) => ({
    statusCode: res.statusCode
  })
};

/** Successful health probes are quiet (Kubernetes hits them constantly). */
export function isHealthProbe(req: IncomingMessage): boolean {
  return req.url?.startsWith('/api/v1/health') ?? false;
}

/** Log level by environment; LOG_LEVEL wins when set. */
export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOG_LEVEL ?? (isProduction(env) ? 'info' : 'debug');
}

/**
 * Pretty transport is a local-development opt-in only (LOG_PRETTY=1):
 * pino-pretty spawns a worker thread that breaks under watch mode and must
 * never ship to production. Returns undefined when disabled so pino uses its
 * default JSON transport.
 */
export function resolveTransport(env: NodeJS.ProcessEnv = process.env) {
  if (env.LOG_PRETTY === '1') {
    return { target: 'pino-pretty', options: { singleLine: true } };
  }
  return undefined;
}
