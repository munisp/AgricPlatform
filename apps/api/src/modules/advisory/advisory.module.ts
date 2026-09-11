import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { AdvisoryController } from './advisory.controller.js';
import { AdvisoryService } from './advisory.service.js';
import { PriceWireController } from './price-wire.controller.js';
import { PriceWireService } from './price-wire.service.js';

@Module({
  imports: [IntegrationsModule],
  // PriceWireController first: its literal 'price-subscriptions/...' and
  // 'price-dispatch/...' routes must register before AdvisoryController's
  // GET :id wildcard.
  controllers: [PriceWireController, AdvisoryController],
  providers: [AdvisoryService, PriceWireService],
  exports: [AdvisoryService, PriceWireService]
})
export class AdvisoryModule {}
