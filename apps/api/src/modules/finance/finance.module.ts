import { Module } from '@nestjs/common';
import { LearningModule } from '../learning/learning.module.js';
import { CreditController } from './credit.controller.js';
import { CreditService } from './credit.service.js';
import { FinanceController } from './finance.controller.js';
import { FinanceService } from './finance.service.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';
import { LoanController } from './loan.controller.js';
import { LoanService } from './loan.service.js';

@Module({
  imports: [LearningModule],
  controllers: [FinanceController, LedgerController, CreditController, LoanController],
  providers: [FinanceService, LedgerService, CreditService, LoanService],
  exports: [FinanceService, LedgerService, CreditService, LoanService]
})
export class FinanceModule {}
