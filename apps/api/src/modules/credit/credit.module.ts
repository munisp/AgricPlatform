import { Module } from '@nestjs/common';
import { CreditApplicationsController } from './applications.controller.js';
import { CreditService } from './credit.service.js';
import { CreditGroupsController } from './groups.controller.js';
import { CreditGroupsService } from './groups.service.js';
import { CreditPortfolioController } from './portfolio.controller.js';
import { CreditProductsController } from './products.controller.js';
import { CreditSavingsController } from './savings.controller.js';
import { CreditSavingsService } from './savings.service.js';
import { SeasonalScheduleService } from './seasonal-schedule.service.js';
import { GeoVerificationModule } from './geo-verification/geo-verification.module.js';
import { CoopScoreModule } from './coop-score.module.js';
import { FinanceModule } from '../finance/finance.module.js';

/**
 * Wave CREDIT (additive): microfinance suite — best-of-both merge of the
 * farmer-data-collection credit/chama/savings domains. Loan lifecycle
 * state machine with guarded CAS transitions, deterministic 5-factor
 * scoring (0–1000), approval-time amortisation schedules, read-time late
 * marking, PAR portfolio reporting, VSLA/chama group lending with
 * co-obligors, and ref-idempotent savings.
 *
 * Disbursement is a RECORDED EVENT in v1: actual money movement stays with
 * the hardened funds/escrow flow (no funds-module changes in this wave).
 */
@Module({
  // Wave GEOCREDIT (additive): shadow-mode geo-verified credit factor.
  // Stage-27 Innovation 14 (additive): institution-level Cooperative Score.
  // Wave-2 (V-05/V-28): settlement write-down and guarantor liability legs
  // post through the double-entry ledger (FinanceModule exports LedgerService;
  // no import cycle — FinanceModule does not depend on CreditModule).
  // FinanceModule: LedgerService for the V-58 savings ledger mirror (no
  // cycle — FinanceModule depends on neither CreditModule nor its peers).
  imports: [GeoVerificationModule, CoopScoreModule, FinanceModule],
  controllers: [
    CreditProductsController,
    CreditApplicationsController,
    CreditGroupsController,
    CreditSavingsController,
    CreditPortfolioController
  ],
  // SeasonSync (innovation wave 27, additive): harvest-linked schedules.
  providers: [CreditService, CreditGroupsService, CreditSavingsService, SeasonalScheduleService],
  exports: [CreditService, CreditGroupsService, CreditSavingsService, SeasonalScheduleService]
})
export class CreditModule {}
