import { Module } from '@nestjs/common';
import { AdvisoryModule } from '../advisory/advisory.module.js';
import { ChaptersModule } from '../chapters/chapters.module.js';
import { CommunityModule } from '../community/community.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { MarketplaceModule } from '../marketplace/marketplace.module.js';
import { OpportunitiesModule } from '../opportunities/opportunities.module.js';
import { SearchController } from './search.controller.js';
import { SEARCH_PROVIDER } from './search.provider.js';
import { SearchService } from './search.service.js';

@Module({
  imports: [
    LearningModule,
    OpportunitiesModule,
    MarketplaceModule,
    AdvisoryModule,
    ChaptersModule,
    CommunityModule
  ],
  controllers: [SearchController],
  providers: [SearchService, { provide: SEARCH_PROVIDER, useExisting: SearchService }],
  exports: [SearchService, SEARCH_PROVIDER]
})
export class SearchModule {}
