import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { newId } from '../../../common/async-repository.js';
import { COMMODITY_PRICE_REPOSITORY } from '../../../database/persistence.tokens.js';
import type {
  CommodityPrice,
  CommodityPriceRepository
} from '../../../database/repositories/commodity-price.repository.js';
import {
  createExchangeFeedSources,
  exchangeFeedsDriverEnabled
} from '../drivers/exchange-feeds.drivers.js';
import type { CommodityPriceReading, MarketDataSource } from '../drivers/market-data.drivers.js';

/** Default cadence: every 6 hours (exchange feeds publish at most daily). */
export const EXCHANGE_FEEDS_DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Scheduled NCX/AFEX price ingestion (wave P5a, matrix Phase 3). Mirrors
 * the market-data ingestion service: the scheduler is inert unless
 * EXCHANGE_FEEDS_DRIVER is live (or sandbox/production) AND at least one
 * feed credential is present. Rows land in advisory.commodity_prices via
 * the existing idempotent upsertMany, so overlapping runs are replay-safe.
 */
@Injectable()
export class ExchangeFeedIngestionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExchangeFeedIngestionService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(COMMODITY_PRICE_REPOSITORY) private readonly prices: CommodityPriceRepository,
    // @Optional: tests inject fake sources/env directly; Nest keeps the
    // env-derived defaults at runtime.
    @Optional() private readonly sources: MarketDataSource[] = createExchangeFeedSources(),
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  get enabled(): boolean {
    return exchangeFeedsDriverEnabled(this.env) && this.sources.length > 0;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      return;
    }
    const intervalMs = Number(
      this.env.EXCHANGE_FEEDS_POLL_INTERVAL_MS ?? EXCHANGE_FEEDS_DEFAULT_INTERVAL_MS
    );
    this.logger.log(
      `Exchange feed ingestion enabled (${this.sources.map((s) => s.name).join(', ')}; every ${intervalMs}ms)`
    );
    void this.ingestOnce().catch((error) =>
      this.logger.warn(`Initial exchange feed ingestion failed: ${(error as Error).message}`)
    );
    this.timer = setInterval(() => {
      void this.ingestOnce().catch((error) =>
        this.logger.warn(`Scheduled exchange feed ingestion failed: ${(error as Error).message}`)
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
