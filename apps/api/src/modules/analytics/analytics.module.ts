import { Module } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { ChaptersModule } from '../chapters/chapters.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { MarketplaceModule } from '../marketplace/marketplace.module.js';
import { OpportunitiesModule } from '../opportunities/opportunities.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsDepthService } from './analytics-depth.service.js';
import { AnalyticsService } from './analytics.service.js';
import {
  LAKEHOUSE_CONFIG,
  lakehouseConfigIncomplete,
  loadLakehouseConfig,
  type LakehouseConfig
} from './exporter/lakehouse.config.js';
import {
  LAKEHOUSE_S3,
  LakehouseExporterService,
  wrapS3Client,
  type LakehouseS3
} from './exporter/lakehouse-exporter.service.js';
import { AnalyticsProjectorService } from './projector.service.js';
import { AnalyticsStarService } from './star-marts.service.js';

/**
 * Builds the S3 client only when the exporter is fully configured; an
 * incomplete enabled config yields null and LakehouseExporterService
 * onModuleInit applies the fail-closed policy (throw in production,
 * degraded-disabled otherwise).
 */
function buildLakehouseS3(config: LakehouseConfig): LakehouseS3 | null {
  if (!config.enabled || lakehouseConfigIncomplete(config)) return null;
  return wrapS3Client(
    new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      // MinIO and most S3-compatible stores need path-style addressing.
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId as string,
        secretAccessKey: config.secretAccessKey as string
      }
    })
  );
}

@Module({
  imports: [ProfilesModule, LearningModule, OpportunitiesModule, MarketplaceModule, ChaptersModule],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    AnalyticsDepthService,
    AnalyticsProjectorService,
    AnalyticsStarService,
    { provide: LAKEHOUSE_CONFIG, useFactory: () => loadLakehouseConfig(process.env) },
    { provide: LAKEHOUSE_S3, useFactory: buildLakehouseS3, inject: [LAKEHOUSE_CONFIG] },
    LakehouseExporterService
  ],
  exports: [AnalyticsProjectorService, AnalyticsStarService, LakehouseExporterService]
})
export class AnalyticsModule {}
