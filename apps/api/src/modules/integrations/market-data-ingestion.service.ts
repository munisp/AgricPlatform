import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { newId } from '../../common/async-repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { COMMODITY_PRICE_REPOSITORY } from '../../database/persistence.tokens.js';
import type {
  CommodityPrice,
  CommodityPriceRepository
} from '../../database/repositories/commodity-price.repository.js';
import {
  createMarketDataSources,
  marketDataDriverEnabled,
  type CommodityPriceReading,
  type MarketDataSource
} from './drivers/market-data.drivers.js';

/** Default cadence: every 6 hours (feeds publish at most daily). */
export const MARKET_DATA_DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * GAP-M10: bounded retry for a failed ingestion pass — previously a
 * transient feed outage silently skipped the whole cycle (the next tick,
 * up to 6h later, was the only "retry"). Exponential backoff from this
 * base, MARKET_DATA_INGEST_MAX_ATTEMPTS attempts total.
 */
export const MARKET_DATA_INGEST_MAX_ATTEMPTS = 3;
/** Base backoff between ingestion retries (doubles per attempt). */
export const MARKET_DATA_INGEST_RETRY_BASE_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scheduled commodity-price ingestion (wave P1 scaffold, matrix M5). The
 * scheduler is disabled unless MARKET_DATA_DRIVER=live (or
 * sandbox/production) AND at least one feed credential is present —
 * otherwise the process stays on stub fixtures and no network I/O occurs.
 * Rows land in advisory.commodity_prices via the repository's idempotent
 * upsertMany so re-ingestion and overlapping runs are replay-safe.
 */
@Injectable()
export class MarketDataIngestionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketDataIngestionService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(COMMODITY_PRICE_REPOSITORY) private readonly prices: CommodityPriceRepository,
    // @Optional: tests inject fake sources/env directly; Nest leaves the
    // defaults (env-derived sources) in place at runtime.
    @Optional() private readonly sources: MarketDataSource[] = createMarketDataSources(),
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env,
    // GAP-M10: exhausted ingestion retries are persisted as an audit event
    // (events.outbox) so a skipped cycle leaves a durable, retention-managed
    // record instead of only a log line. Optional so bare unit constructions
    // keep working; Nest injects the shared DomainEventsService at runtime.
    @Optional() private readonly events?: DomainEventsService
  ) {}

  get enabled(): boolean {
    return marketDataDriverEnabled(this.env) && this.sources.length > 0;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      return;
    }
    const intervalMs = Number(
      this.env.MARKET_DATA_POLL_INTERVAL_MS ?? MARKET_DATA_DEFAULT_INTERVAL_MS
    );
    this.logger.log(
      `Market data ingestion enabled (${this.sources.map((s) => s.name).join(', ')}; every ${intervalMs}ms)`
    );
    // Kick off an immediate run, then schedule; errors are logged, never fatal.
    void this.ingestOnce().catch((error) =>
      this.logger.warn(`Initial market data ingestion failed: ${(error as Error).message}`)
    );
    this.timer = setInterval(() => {
      void this.ingestOnce().catch((error) =>
        this.logger.warn(`Scheduled market data ingestion failed: ${(error as Error).message}`)
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /**
   * One ingestion pass across all configured sources, with a bounded
   * retry + exponential backoff (GAP-M10). A pass that exhausts its
   * attempts fails CLOSED: the failure is error-logged AND persisted as an
   * `advisory.market_data_ingestion.failed` audit event (durable in
   * events.outbox, classified audit-only in the consumer-coverage
   * registry) before the error propagates to the caller — a silently
   * skipped cycle is how stale prices hide.
   * Attempt/backoff are env-tunable: MARKET_DATA_INGEST_MAX_ATTEMPTS
   * (default 3), MARKET_DATA_INGEST_RETRY_BASE_MS (default 30000).
   * Returns rows inserted.
   */
  async ingestOnce(): Promise<number> {
    const maxAttempts = this.intFromEnv('MARKET_DATA_INGEST_MAX_ATTEMPTS', MARKET_DATA_INGEST_MAX_ATTEMPTS);
    const retryBaseMs = this.intFromEnv('MARKET_DATA_INGEST_RETRY_BASE_MS', MARKET_DATA_INGEST_RETRY_BASE_MS);
    let attempt = 0;
    let lastError: unknown;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await this.ingestPass();
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `market data ingestion pass failed (attempt ${attempt}/${maxAttempts}): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        if (attempt < maxAttempts) {
          await sleep(retryBaseMs * 2 ** (attempt - 1));
        }
      }
    }
    // Exhausted: durable failure record BEFORE the throw (best-effort — a
    // broken event spine must not mask the original error).
    this.logger.error(
      `market data ingestion exhausted ${maxAttempts} attempts; cycle skipped: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
    try {
      await this.events?.publish('advisory.market_data_ingestion.failed', {
        sources: this.sources.map((source) => source.name),
        attempts: maxAttempts,
        error: lastError instanceof Error ? lastError.message : String(lastError)
      });
    } catch (publishError) {
      this.logger.warn(
        `failed to persist the ingestion-failure audit event: ${
          publishError instanceof Error ? publishError.message : String(publishError)
        }`
      );
    }
    throw lastError;
  }

  /** Single unretried ingestion pass across all configured sources. */
  private async ingestPass(): Promise<number> {
    let inserted = 0;
    for (const source of this.sources) {
      const readings = await source.fetchLatest();
      inserted += await this.prices.upsertMany(readings.map((reading) => this.toRow(reading)));
    }
    return inserted;
  }

  private intFromEnv(name: string, fallback: number): number {
    const parsed = Number(this.env[name] ?? fallback);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  private toRow(reading: CommodityPriceReading): CommodityPrice {
    return {
      id: newId('price'),
      commodity: reading.commodity,
      market: reading.market,
      state: reading.state,
      lga: reading.lga,
      priceNgn: reading.priceNgn,
      source: reading.source,
      observedAt: reading.observedAt,
      ingestedAt: new Date().toISOString()
    };
  }
}
