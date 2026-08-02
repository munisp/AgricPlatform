import { Module } from '@nestjs/common';
import { AdvisoryModule } from '../advisory/advisory.module.js';
import { ChaptersModule } from '../chapters/chapters.module.js';
import { CommunityModule } from '../community/community.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { MarketplaceModule } from '../marketplace/marketplace.module.js';
import { OpportunitiesModule } from '../opportunities/opportunities.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { RecommendationService } from './recommendation.service.js';
import { RecommendationsController } from './recommendations.controller.js';
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
    CommunityModule,
    // Wave P5c: member signals for the recommender.
    ProfilesModule
  ],
  controllers: [SearchController, RecommendationsController],
  providers: [
    SearchService,
    { provide: SEARCH_PROVIDER, useExisting: SearchService },
    RecommendationService
  ],
  exports: [SearchService, SEARCH_PROVIDER, RecommendationService]
})
export class SearchModule {}
