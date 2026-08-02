import { Module } from '@nestjs/common';
import { ServicesMarketplaceController } from './services-marketplace.controller.js';
import { ServicesMarketplaceService } from './services-marketplace.service.js';

@Module({
  controllers: [ServicesMarketplaceController],
  providers: [ServicesMarketplaceService],
  exports: [ServicesMarketplaceService]
})
export class ServicesMarketplaceModule {}
