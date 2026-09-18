import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { catchError, mergeMap, Observable, of } from 'rxjs';
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
 *
 * Concurrent-twin serialization (Stage 27 WP-G11): two simultaneous FIRST
 * requests with the same key previously both missed the cache and both
 * executed the mutation (the check-then-act gap between `store.get` and the
 * post-response `store.save`). A per-key in-process advisory lock now
 * serialises them: the twin waits for the first request's response to be
 * cached, then replays it (or 409s on body mismatch) instead of executing a
 * duplicate. The lock is per replica; cross-instance duplicates are stopped
 * by the service-level UNIQUE constraints on the idempotency-keyed records
 * (adopt-on-23505), which remain the correctness backstop.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  /** Per-scoped-key promise-chain mutex (per replica). */
  private readonly keyLocks = new Map<string, Promise<void>>();

  constructor(
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore,
    private readonly metrics: MetricsService
  ) {}

  /**
   * Takes the per-key advisory lock. The get-and-set chain contains NO
   * await, so concurrent callers register their turn atomically in one
   * synchronous tick (same doctrine as the in-memory repository CAS).
   */
  private async acquireKeyLock(scopedKey: string): Promise<() => void> {
    const previous = this.keyLocks.get(scopedKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => current);
    this.keyLocks.set(scopedKey, chain);
    void chain.then(() => {
      // Clean up only when no newer caller has chained onto this key.
      if (this.keyLocks.get(scopedKey) === chain) {
        this.keyLocks.delete(scopedKey);
      }
    });
    await previous;
    return release;
  }

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

    // Principal scoping (V-15): the cache domain is per-caller, so the same
    // Idempotency-Key used by two different users can neither replay the
    // other user's response nor act as a key-existence oracle / pre-claim
    // DoS. Unauthenticated routes fall back to the client IP. The query
    // string is normalised out of the URL (dim05-scenario-3): retrying with
    // a different tracking parameter must not lose replay protection.
    const user = (request as Request & { user?: { id?: unknown } }).user;
    const principal =
      typeof user?.id === 'string' && user.id.length > 0
        ? `user:${user.id}`
        : `ip:${request.ip ?? 'unknown'}`;
    const path = request.originalUrl.split('?')[0];
    const scopedKey = `${request.method}:${path}:${principal}:${key}`;
    const requestHash = hashRequestBody(request.body);
    // Serialize concurrent twins (WP-G11): the twin waits for the first
    // request's response to be cached before its own cache lookup, so it
    // replays (or 409s on body mismatch) instead of executing a duplicate
    // mutation. The lock releases only AFTER the envelope is stored.
    const release = await this.acquireKeyLock(scopedKey);
    let cached: unknown;
    try {
      cached = await this.store.get(scopedKey);
    } catch (error) {
      release();
      // FAIL-CLOSED (V-77): the idempotency store is a store of RECORD, not
      // a cache — proceeding without it could execute a duplicate mutation.
      // Answer a clean 503 (retryable) instead of leaking a raw 500; the
      // throttler cache tier fails OPEN by contrast.
      throw new ServiceUnavailableException(
        `Idempotency store unavailable — retry the request later (${error instanceof Error ? error.message : String(error)})`
      );
    }
    if (cached !== undefined) {
      release();
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
      // Await the envelope save BEFORE emitting and BEFORE releasing the
      // lock: a queued twin must observe the cached response, never an
      // empty cache.
      mergeMap(async (body) => {
        const envelope: IdempotencyEnvelope = { requestHash, body };
        try {
          await this.store.save(scopedKey, envelope);
        } catch (error) {
          // FAIL-CLOSED (V-77): without the cached envelope the twin/retry
          // cannot replay — surface 503 so the client retries with the same
          // key; service-level UNIQUE constraints backstop the duplicate.
          throw new ServiceUnavailableException(
            `Idempotency store unavailable — retry the request with the same Idempotency-Key (${error instanceof Error ? error.message : String(error)})`
          );
        } finally {
          release();
        }
        return body;
      }),
      catchError((error: unknown) => {
        // A failed first request caches nothing: the next caller with this
        // key retries as a fresh first request.
        release();
        throw error;
      })
    );
  }
}
