import { Module } from '@nestjs/common';
import { AdvisoryModule } from '../advisory/advisory.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { MarketplaceModule } from '../marketplace/marketplace.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { InboundConversationsService } from './inbound-conversations.service.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  imports: [
    IntegrationsModule,
    AdvisoryModule,
    LearningModule,
    MarketplaceModule,
    // Wave P6b: listing location state comes from the member profile.
    ProfilesModule
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, InboundConversationsService],
  exports: [NotificationsService, InboundConversationsService]
})
export class NotificationsModule {}
