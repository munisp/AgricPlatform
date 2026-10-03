import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { newId } from '../../common/async-repository.js';
import {
  GEO_INTEL_ALERT_REPOSITORY,
  GEO_INTEL_FEED_STATE_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  GeoIntelAlert,
  GeoIntelAlertRepository,
  GeoIntelFeedStateRepository
} from '../../database/repositories/geo-intel.repository.js';
import { createGeoIntelFeed, type GeoIntelFeed, type GeoIntelReading } from './drivers/geo-intel.drivers.js';
import { geoIntelDriverEnabled } from './drivers/geo-intel.drivers.js';

/** Default feed poll cadence: 30 minutes (watch-tower freshness target). */
export const GEO_INTEL_DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
/**
 * Dedupe window for identical alerts (same source+kind+h3): a re-polled
 * feed row inside this window updates the existing alert instead of
 * creating a duplicate.
 */
export const GEO_INTEL_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Geo-intelligence ingest (wave GEOINTEL): polls the configured
 * deforestation/weather/conflict feeds, normalises readings into h3-keyed
 * alerts and stores them with 24h dedupe. Fail-closed: the scheduler stays
 * off unless GEO_INTEL_DRIVER=live|sandbox AND a feed endpoint+key are
 * configured (geo-intel.drivers.ts); a live driver that fails propagates —
 * never a fabricated clear-sky.
 */
@Injectable()
export class GeoIntelService {
  private readonly logger = new Logger(GeoIntelService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(GEO_INTEL_ALERT_REPOSITORY) private readonly alerts: GeoIntelAlertRepository,
    @Inject(GEO_INTEL_FEED_STATE_REPOSITORY) private readonly feedState: GeoIntelFeedStateRepository,
    // @Optional: tests inject a fake feed/env directly; Nest derives the
    // configured feed from env at runtime.
    @Optional() private readonly feed: GeoIntelFeed | null = createGeoIntelFeed(process.env),
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  get enabled(): boolean {
    return geoIntelDriverEnabled(this.env) && this.feed !== null;
  }

  /** Feed diagnostics for the admin status endpoint — honest, never fabricated. */
  status() {
    return {
      enabled: this.enabled,
      driver: this.env.GEO_INTEL_DRIVER ?? 'stub',
      feed: this.feed?.name ?? null,
      lastSuccessAt: undefined as string | undefined
    };
  }

  onModuleInit(): void {
    if (!this.enabled) {
      return;
    }
    const intervalMs = Number(this.env.GEO_INTEL_POLL_INTERVAL_MS ?? GEO_INTEL_DEFAULT_INTERVAL_MS);
    this.logger.log(`Geo-intel ingest enabled (feed ${this.feed!.name}; every ${intervalMs}ms)`);
    void this.ingestOnce().catch((error) =>
      this.logger.warn(`Initial geo-intel ingest failed: ${(error as Error).message}`)
    );
    this.timer = setInterval(() => {
      void this.ingestOnce().catch((error) =>
        this.logger.warn(`Scheduled geo-intel ingest failed: ${(error as Error).message}`)
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
   * One ingest pass: fetch the feed, normalise to alerts, dedupe on
   * (source, kind, h3Index) within the 24h window. Returns rows upserted.
   * A live feed failure propagates (fail-closed); the scheduler logs it.
   */
  async ingestOnce(): Promise<number> {
    if (!this.feed) {
      throw new ServiceUnavailableException(
        'Geo-intel feed is not configured. Set GEO_INTEL_DRIVER=live|sandbox with a feed endpoint and key.'
      );
    }
    const readings: GeoIntelReading[] = await this.feed.fetchLatest();
    let upserted = 0;
    const now = Date.now();
    for (const reading of readings) {
      const alert: GeoIntelAlert = {
        id: newId('geoalert'),
        source: reading.source,
        kind: reading.kind,
        severity: reading.severity,
        h3Index: reading.h3Index,
        state: reading.state,
        lga: reading.lga,
        summary: reading.summary,
        detail: reading.detail,
        observedAt: reading.observedAt,
        ingestedAt: new Date(now).toISOString()
      };
      upserted += await this.alerts.upsertDeduped(alert, GEO_INTEL_DEDUPE_WINDOW_MS);
    }
    await this.feedState.recordSuccess(this.feed.name, new Date(now).toISOString());
    return upserted;
  }

  /** Alerts overlapping an h3 cell (watch-tower + credit geo-verification reads). */
  async alertsForH3(h3Index: string): Promise<GeoIntelAlert[]> {
    return this.alerts.find({ h3Index });
  }

  /** Newest alerts for a state (ops review), bounded. */
  async alertsForState(state: string, limit = 50): Promise<GeoIntelAlert[]> {
    return this.alerts.recentForState(state, limit);
  }
}
