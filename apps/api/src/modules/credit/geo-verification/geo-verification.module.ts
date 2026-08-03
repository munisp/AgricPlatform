import { Module } from '@nestjs/common';
import { GeoVerificationController } from './geo-verification.controller.js';
import { GeoVerificationService } from './geo-verification.service.js';

/**
 * Wave GEOCREDIT (additive): geo-verified credit — a deterministic sixth
 * credit-scoring factor from geospatial plot verification, running in
 * SHADOW MODE. Scores persist only to credit.geo_credit_shadow_scores
 * (migration 028) and are exposed read-only to credit officers; the live
 * decision path never reads them.
 */
@Module({
  controllers: [GeoVerificationController],
  providers: [GeoVerificationService],
  exports: [GeoVerificationService]
})
export class GeoVerificationModule {}
