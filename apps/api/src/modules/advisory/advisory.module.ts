import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { AdvisoryController } from './advisory.controller.js';
import { AdvisoryService } from './advisory.service.js';
import { PlantingPulseController } from './planting-pulse.controller.js';
import { PlantingPulseService } from './planting-pulse.service.js';
import { PriceWireController } from './price-wire.controller.js';
import { PriceWireService } from './price-wire.service.js';

@Module({
  imports: [IntegrationsModule],
  // PlantingPulseController and PriceWireController first: their literal
  // 'subscriptions/...', 'price-subscriptions/...' and 'price-dispatch/...'
  // routes must register before AdvisoryController's GET :id wildcard.
  controllers: [PlantingPulseController, PriceWireController, AdvisoryController],
  providers: [AdvisoryService, PlantingPulseService, PriceWireService],
  exports: [AdvisoryService, PlantingPulseService, PriceWireService]
})
export class AdvisoryModule {}
