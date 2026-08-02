import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { AdvisoryItem } from '@agric-platform/shared';
import { ADVISORY_REPOSITORY } from '../../../database/persistence.tokens.js';
import type { AdvisoryRepository } from '../../../database/repositories/advisory.repository.js';
import {
  createExtensionFeedSources,
  extensionFeedDriverEnabled,
  type ExtensionBulletin,
  type ExtensionFeedSource
} from '../drivers/extension-feeds.drivers.js';

/** Default cadence: every 12 hours (bulletins publish at most daily). */
export const EXTENSION_FEED_DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * Scheduled NAERLS / FMARD e-Extension advisory pull (wave P5a, matrix
 * Phase 3). Read-only: bulletins map onto AdvisoryItems tagged with source
 * + region and deterministic ids (`ext-{source}-{externalId}`), so reruns
 * dedupe by id. The scheduler is inert unless EXTENSION_FEED_DRIVER is
 * live (or sandbox/production) AND at least one feed credential is
 * present — mirroring the market-data ingestion pattern.
 */
@Injectable()
export class ExtensionAdvisoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExtensionAdvisoryService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(ADVISORY_REPOSITORY) private readonly advisory: AdvisoryRepository,
    // @Optional: tests inject fake sources/env directly; Nest keeps the
    // env-derived defaults at runtime.
    @Optional() private readonly sources: ExtensionFeedSource[] = createExtensionFeedSources(),
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  get enabled(): boolean {
    return extensionFeedDriverEnabled(this.env) && this.sources.length > 0;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      return;
    }
    const intervalMs = Number(
      this.env.EXTENSION_FEED_POLL_INTERVAL_MS ?? EXTENSION_FEED_DEFAULT_INTERVAL_MS
    );
    this.logger.log(
      `e-Extension advisory pull enabled (${this.sources.map((s) => s.name).join(', ')}; every ${intervalMs}ms)`
    );
    void this.ingestOnce().catch((error) =>
      this.logger.warn(`Initial e-Extension pull failed: ${(error as Error).message}`)
    );
    this.timer = setInterval(() => {
      void this.ingestOnce().catch((error) =>
        this.logger.warn(`Scheduled e-Extension pull failed: ${(error as Error).message}`)
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** One pull pass across all configured sources. Returns items inserted. */
  async ingestOnce(): Promise<number> {
    let inserted = 0;
    for (const source of this.sources) {
      for (const bulletin of await source.fetchLatest()) {
        const item = this.toAdvisoryItem(bulletin, source.name);
        if (await this.advisory.findById(item.id)) {
          continue; // replay-safe: deterministic id dedupe
        }
        await this.advisory.create(item);
        inserted += 1;
      }
    }
    return inserted;
  }

  private toAdvisoryItem(bulletin: ExtensionBulletin, sourceName: string): AdvisoryItem {
    return {
      id: `ext-${sourceName}-${bulletin.externalId}`,
      kind: bulletin.kind,
      title: `[${bulletin.source}] ${bulletin.title}`,
      summary: bulletin.summary,
      state: bulletin.state,
      crop: bulletin.crop,
      severity: bulletin.severity,
      publishedAt: bulletin.publishedAt
    };
  }
}
