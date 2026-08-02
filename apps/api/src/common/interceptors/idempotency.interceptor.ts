import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { Observable, of, tap } from 'rxjs';
import { IDEMPOTENCY_STORE } from '../../database/persistence.tokens.js';
import type { IdempotencyStore } from '../../redis/idempotency.store.js';
import { MetricsService } from '../metrics/metrics.service.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Cached envelope: the response body plus a hash of the request body it was
 * produced from. Stored JSON-serialized so the shape survives Redis.
 */
interface IdempotencyEnvelope {
  requestHash: string;
  body: unknown;
}

function isEnvelope(value: unknown): value is IdempotencyEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'requestHash' in value &&
    'body' in value &&
    typeof (value as IdempotencyEnvelope).requestHash === 'string'
  );
}

/** Stable request-body fingerprint for key-mismatch detection. */
export function hashRequestBody(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body ?? null))
    .digest('hex');
}

/**
 * Idempotency support for retryable mutations (SPEC contract 3). Clients send
 * an `Idempotency-Key` header; the first successful response is cached and
 * replays return the cached body with an `Idempotent-Replay: true` header.
 *
 * Key-mismatch safety (Wave P3): the request body is hashed alongside the
 * cached response; reusing the same key with a DIFFERENT body is a client
 * error and returns 409 instead of silently replaying the wrong result.
 * Entries cached before this change (plain bodies, no envelope) still replay.
 *
 * The store is injected (Redis in production, in-memory otherwise) so replay
 * safety holds across replicas (persistence wave plan §7).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore,
    private readonly metrics: MetricsService
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    if (!MUTATING_METHODS.has(request.method)) {
      return next.handle();
    }

    const keyHeader = request.headers['idempotency-key'];
    const key = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
    if (!key) {
      return next.handle();
    }

    const scopedKey = `${request.method}:${request.originalUrl}:${key}`;
    const requestHash = hashRequestBody(request.body);
    const cached = await this.store.get(scopedKey);
    if (cached !== undefined) {
      if (isEnvelope(cached)) {
        if (cached.requestHash !== requestHash) {
          throw new ConflictException(
            'Idempotency-Key was already used with a different request body'
          );
        }
        this.metrics.idempotentReplay();
        response.setHeader('Idempotent-Replay', 'true');
        return of(cached.body);
      }
      // Legacy entry (pre-envelope): replay as-is.
      this.metrics.idempotentReplay();
      response.setHeader('Idempotent-Replay', 'true');
      return of(cached);
    }

    return next.handle().pipe(
      tap((body) => {
        const envelope: IdempotencyEnvelope = { requestHash, body };
        void this.store.save(scopedKey, envelope);
      })
    );
  }
}
