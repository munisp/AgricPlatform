import { Module } from '@nestjs/common';
import {
  COLD_CHAIN_PROVIDER,
  LIVESTOCK_INSURANCE_PROVIDER
} from '../../database/persistence.tokens.js';
import { PrivacyModule } from '../privacy/privacy.module.js';
import { AggregationPointsService } from './aggregation-points.service.js';
import { CertifiedListingsService } from './certified-listings.service.js';
import { ColdChainService } from './cold-chain.service.js';
import { ComplianceService } from './compliance.service.js';
import { DisbursementsService } from './disbursements.service.js';
import { ExportDocumentsService } from './export-documents.service.js';
import { LivestockComplianceController } from './compliance.controller.js';
import { LivestockFinanceController } from './finance.controller.js';
import { LivestockPartnersController } from './partners.controller.js';
import { LivestockTradeController } from './trade.controller.js';
import { InsuranceService } from './insurance.service.js';
import { LiensService } from './liens.service.js';
import { OfftakeService } from './offtake.service.js';
import { createColdChainProvider, createLivestockInsuranceProvider } from './provider-stubs.js';

/**
 * ALTP wave L1c: certified trade (F4), livestock finance (F5), regulator
 * compliance (F6) and partner aggregation (F7).
 *
 * ⚖ LEGAL ACTIVATION NOTE: the lien registration/enforcement flows
 * (LiensService and the LIVESTOCK_TRANSFER_GUARD wired into
 * LivestockService.transferAnimal by the DatabaseModule) must undergo
 * qualified Nigerian legal/regulatory review before production activation.
 *
 * Integration points left for the L1b health wave:
 *  - InsuranceService subscribes to `livestock.recall.initiated`
 *    ({ recallId, animalIds }) and auto-drafts recall claims.
 *  - ComplianceService emits health_records/movements CSV sections as
 *    headers-only placeholders until L1b data sources exist.
 */
@Module({
  imports: [PrivacyModule],
  controllers: [
    LivestockTradeController,
    LivestockFinanceController,
    LivestockComplianceController,
    LivestockPartnersController
  ],
  providers: [
    CertifiedListingsService,
    OfftakeService,
    ExportDocumentsService,
    LiensService,
    InsuranceService,
    ComplianceService,
    DisbursementsService,
    AggregationPointsService,
    ColdChainService,
    // Fail-closed provider stubs (no external calls without configuration).
    { provide: LIVESTOCK_INSURANCE_PROVIDER, useFactory: createLivestockInsuranceProvider },
    { provide: COLD_CHAIN_PROVIDER, useFactory: createColdChainProvider }
  ],
  exports: [LiensService, InsuranceService]
})
export class LivestockTradeModule {}
