import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { AdvisoryController } from './advisory.controller.js';
import { AdvisoryService } from './advisory.service.js';
import { PlantingPulseController } from './planting-pulse.controller.js';
import { PlantingPulseService } from './planting-pulse.service.js';

@Module({
  imports: [IntegrationsModule],
  // PlantingPulseController first: its literal 'subscriptions/...' routes
  // must register before AdvisoryController's GET :id wildcard.
  controllers: [PlantingPulseController, AdvisoryController],
  providers: [AdvisoryService, PlantingPulseService],
  exports: [AdvisoryService, PlantingPulseService]
})
export class AdvisoryModule {}
