import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, of, tap } from 'rxjs';

interface CachedResponse {
  body: unknown;
  expiresAt: number;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h replay window
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Idempotency support for retryable mutations (SPEC contract 3). Clients send
 * an `Idempotency-Key` header; the first successful response is cached and
 * replays return the cached body with an `Idempotent-Replay: true` header.
 *
 * Phase 1 uses an in-process Map; production swaps the store for Redis per
 * SPEC contract 5 (Redis is cache/idempotency).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly store = new Map<string, CachedResponse>();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
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

    this.sweepExpired();
    const scopedKey = `${request.method}:${request.originalUrl}:${key}`;
    const cached = this.store.get(scopedKey);
    if (cached) {
      response.setHeader('Idempotent-Replay', 'true');
      return of(cached.body);
    }

    return next.handle().pipe(
      tap((body) => {
        this.store.set(scopedKey, { body, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
      })
    );
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, value] of this.store) {
      if (value.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }
}
