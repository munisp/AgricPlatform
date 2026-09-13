/**
 * Lender Lens module (Stage 27, innovation #20) — standardized, versioned
 * lender portfolio scorecards.
 *
 * Deliberately self-contained so the in-flight analytics / partner-api waves
 * stay untouched: the repository DI token and provider live here (not in
 * persistence.tokens.ts / database.module.ts), and the partner-scoped
 * controller is declared here while reusing the guard exported by
 * PartnerApiModule. All other collaborators (outbox, credit/profile/star
 * repositories, DomainEventsService, FeatureFlagsService, TelemetryService)
 * come from the global modules.
 */
import { Module } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import type pg from 'pg';
import { PG_POOL } from '../../database/persistence.tokens.js';
import { createInMemoryLenderScorecardRepository, LENDER_SCORECARD_REPOSITORY } from '../../database/repositories/lender-scorecard.repository.js';
import { createPgLenderScorecardRepository } from '../../database/repositories/lender-scorecard.pg-repository.js';
import { PartnerApiModule } from '../partner-api/partner-api.module.js';
import { PortfolioScorecardController } from '../partner-api/portfolio-scorecard.controller.js';
import {
  lakehouseConfigIncomplete,
  type LakehouseConfig
} from './exporter/lakehouse.config.js';
import { wrapS3Client, type LakehouseS3 } from './exporter/lakehouse-exporter.service.js';
import { LenderScorecardAdminController } from './lender-scorecard-admin.controller.js';
import {
  LENDER_LENS_EXPORT_CONFIG,
  LENDER_LENS_S3,
  LenderScorecardExportService,
  loadLenderLensExportConfig
} from './lender-scorecard-export.service.js';
import { LenderScorecardService } from './lender-scorecard.service.js';

/**
 * Builds the S3 client only when the exporter is fully configured (same
 * doctrine as the lakehouse exporter); otherwise null and the export
 * endpoint fails closed with 503.
 */
function buildLenderLensS3(config: LakehouseConfig): LakehouseS3 | null {
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
  imports: [PartnerApiModule],
  controllers: [LenderScorecardAdminController, PortfolioScorecardController],
  providers: [
    {
      provide: LENDER_SCORECARD_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgLenderScorecardRepository(pool) : createInMemoryLenderScorecardRepository(),
      inject: [PG_POOL]
    },
    LenderScorecardService,
    { provide: LENDER_LENS_EXPORT_CONFIG, useFactory: () => loadLenderLensExportConfig(process.env) },
    { provide: LENDER_LENS_S3, useFactory: buildLenderLensS3, inject: [LENDER_LENS_EXPORT_CONFIG] },
    LenderScorecardExportService
  ]
})
export class LenderLensModule {}
