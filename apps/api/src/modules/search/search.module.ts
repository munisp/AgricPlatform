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
import { createOpenSearchProvider } from '../integrations/drivers/opensearch.driver.js';
import { SearchController } from './search.controller.js';
import { SEARCH_PROVIDER, type SearchProvider } from './search.provider.js';
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
    // Wave FABRIC: driver selection behind the port. Default returns the
    // in-process SearchService (current behaviour, unchanged);
    // SEARCH_DRIVER=opensearch binds the fail-closed OpenSearch driver.
    {
      provide: SEARCH_PROVIDER,
      useFactory: (search: SearchService): SearchProvider =>
        createOpenSearchProvider(process.env, search),
      inject: [SearchService]
    },
    RecommendationService
  ],
  exports: [SearchService, SEARCH_PROVIDER, RecommendationService]
})
export class SearchModule {}
