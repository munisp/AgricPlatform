import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, of, tap } from 'rxjs';
import { IDEMPOTENCY_STORE } from '../../database/persistence.tokens.js';
import type { IdempotencyStore } from '../../redis/idempotency.store.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Idempotency support for retryable mutations (SPEC contract 3). Clients send
 * an `Idempotency-Key` header; the first successful response is cached and
 * replays return the cached body with an `Idempotent-Replay: true` header.
 *
 * The store is injected (Redis in production, in-memory otherwise) so replay
 * safety holds across replicas (persistence wave plan §7).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore
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
    const cached = await this.store.get(scopedKey);
    if (cached !== undefined) {
      response.setHeader('Idempotent-Replay', 'true');
      return of(cached);
    }

    return next.handle().pipe(
      tap((body) => {
        void this.store.save(scopedKey, body);
      })
    );
  }
}
