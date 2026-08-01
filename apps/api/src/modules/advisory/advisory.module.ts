import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { AdvisoryController } from './advisory.controller.js';
import { AdvisoryService } from './advisory.service.js';

@Module({
  imports: [IntegrationsModule],
  controllers: [AdvisoryController],
  providers: [AdvisoryService],
  exports: [AdvisoryService]
})
export class AdvisoryModule {}
