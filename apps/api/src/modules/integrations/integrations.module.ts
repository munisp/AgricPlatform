import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { MarketplaceModule } from '../marketplace/marketplace.module.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { MarketDataIngestionService } from './market-data-ingestion.service.js';
// Phase-3 federated integrations (wave P5a).
import { BeneficiaryImportService } from './phase3/beneficiary-import.service.js';
import { ExchangeFeedIngestionService } from './phase3/exchange-feed-ingestion.service.js';
import { ExtensionAdvisoryService } from './phase3/extension-advisory.service.js';
import { ExternalAccountsService } from './phase3/external-accounts.service.js';
import { FarmRecordsService } from './phase3/farm-records.service.js';
import { LenderIntegrationService } from './phase3/lender-integration.service.js';
import { OfnSyndicationService } from './phase3/ofn-syndication.service.js';
import { Phase3Controller } from './phase3/phase3.controller.js';

@Module({
  imports: [FinanceModule, MarketplaceModule],
  controllers: [IntegrationsController, Phase3Controller],
  providers: [
    IntegrationsService,
    MarketDataIngestionService,
    ExternalAccountsService,
    FarmRecordsService,
    OfnSyndicationService,
    BeneficiaryImportService,
    LenderIntegrationService,
    ExtensionAdvisoryService,
    ExchangeFeedIngestionService
  ],
  exports: [IntegrationsService]
})
export class IntegrationsModule {}
