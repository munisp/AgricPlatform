import { Injectable } from '@nestjs/common';

interface Bucket {
  tokens: number;
  /** Epoch ms of the last refill. */
  refilledAt: number;
}

/**
 * Per-client token bucket (wave P5d). Capacity is the client's
 * rate_limit_per_min (default 1000); tokens refill continuously at
 * capacity/60000 per ms. Burst policy: a full bucket absorbs short bursts
 * up to the whole minute's allowance, after which requests are limited to
 * the sustained per-minute rate. In-memory like the global ThrottlerModule
 * (single replica); TODO(prod): back with Redis for multi-replica limits.
 */
@Injectable()
export class PartnerRateService {
  private readonly buckets = new Map<string, Bucket>();

  /**
   * Consumes one token for the client. Returns the remaining allowance, or
   * null when the bucket is empty (caller answers 429).
   */
  consume(clientId: string, limitPerMin: number, now = Date.now()): number | null {
    const bucket = this.buckets.get(clientId) ?? { tokens: limitPerMin, refilledAt: now };
    const elapsed = Math.max(0, now - bucket.refilledAt);
    const refill = (elapsed / 60_000) * limitPerMin;
    bucket.tokens = Math.min(limitPerMin, bucket.tokens + refill);
    bucket.refilledAt = now;
    if (bucket.tokens < 1) {
      this.buckets.set(clientId, bucket);
      return null;
    }
    bucket.tokens -= 1;
    this.buckets.set(clientId, bucket);
    return Math.floor(bucket.tokens);
  }

  /** Test hook: clears all buckets. */
  reset(): void {
    this.buckets.clear();
  }
}
