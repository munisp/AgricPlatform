import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { newId } from '../../common/async-repository.js';
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
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
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

  /** One ingestion pass across all configured sources. Returns rows inserted. */
  async ingestOnce(): Promise<number> {
    let inserted = 0;
    for (const source of this.sources) {
      const readings = await source.fetchLatest();
      inserted += await this.prices.upsertMany(readings.map((reading) => this.toRow(reading)));
    }
    return inserted;
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
