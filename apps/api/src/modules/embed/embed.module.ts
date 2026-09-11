import { Module } from '@nestjs/common';
import { AdvisoryModule } from '../advisory/advisory.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { OpportunitiesModule } from '../opportunities/opportunities.module.js';
import { EmbedController } from './embed.controller.js';

/**
 * Anonymous read-only embed feeds for the public widget bundles (wave P5d).
 * No PII, CORS-open, cache-friendly. Stage 27 (innovation 11) adds the
 * freshness-gated Price Wire quote endpoint (AdvisoryModule; no cycle —
 * advisory imports integrations only).
 */
@Module({
  imports: [OpportunitiesModule, LearningModule, AdvisoryModule],
  controllers: [EmbedController]
})
export class EmbedModule {}
