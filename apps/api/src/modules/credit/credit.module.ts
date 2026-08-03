import { Module } from '@nestjs/common';
import { CreditApplicationsController } from './applications.controller.js';
import { CreditService } from './credit.service.js';
import { CreditGroupsController } from './groups.controller.js';
import { CreditGroupsService } from './groups.service.js';
import { CreditPortfolioController } from './portfolio.controller.js';
import { CreditProductsController } from './products.controller.js';
import { CreditSavingsController } from './savings.controller.js';
import { CreditSavingsService } from './savings.service.js';

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
  controllers: [
    CreditProductsController,
    CreditApplicationsController,
    CreditGroupsController,
    CreditSavingsController,
    CreditPortfolioController
  ],
  providers: [CreditService, CreditGroupsService, CreditSavingsService],
  exports: [CreditService, CreditGroupsService, CreditSavingsService]
})
export class CreditModule {}
