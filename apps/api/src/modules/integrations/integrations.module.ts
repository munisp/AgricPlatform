import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { MarketDataIngestionService } from './market-data-ingestion.service.js';

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, MarketDataIngestionService],
  exports: [IntegrationsService]
})
export class IntegrationsModule {}
