import { Module } from '@nestjs/common';
import { LearningModule } from '../learning/learning.module.js';
import { OpportunitiesModule } from '../opportunities/opportunities.module.js';
import { EmbedController } from './embed.controller.js';

/**
 * Anonymous read-only embed feeds for the public widget bundles (wave P5d).
 * No PII, CORS-open, cache-friendly.
 */
@Module({
  imports: [OpportunitiesModule, LearningModule],
  controllers: [EmbedController]
})
export class EmbedModule {}
