import { Module } from '@nestjs/common';
import { PartnerApiModule } from '../partner-api/partner-api.module.js';
import { CoopScorePartnerController } from './coop-score-partner.controller.js';
import { CoopScoreController } from './coop-score.controller.js';
import { CoopScoreService } from './coop-score.service.js';

/**
 * Stage-27 Innovation 14 (additive): Cooperative Score — deterministic,
 * explainable institution-level credit readiness (0-1000) for the
 * cooperative itself, assembled from read models across credit, vsla-carbon,
 * chapters and marketplace (read-only consumption). Scores persist
 * versioned + append-only to credit.coop_scores (migration 072). PartnerApiModule
 * is imported so the partner read surface reuses the API-key/OAuth guard
 * unchanged (wave-insurance composition); gated behind flag `coop-score`
 * (default OFF).
 */
@Module({
  imports: [PartnerApiModule],
  controllers: [CoopScoreController, CoopScorePartnerController],
  providers: [CoopScoreService],
  exports: [CoopScoreService]
})
export class CoopScoreModule {}
