import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { UsersModule } from '../users/users.module.js';
import { AgentBankingController, AgentUssdController } from './agent-banking.controller.js';
import { AgentBankingService } from './agent-banking.service.js';
import { AgentUssdService } from './agent-ussd.service.js';
import { OTP_DRIVER_TOKEN, createOtpDriver } from './otp.driver.js';

/**
 * Agent banking (wave AGENTBANK): rural agent float (ledger-backed),
 * farmer cash-in/cash-out with OTP presence proof, HMAC-signed offline
 * vouchers, deterministic commissions, agent USSD ops and daily
 * reconciliation. All value movement posts through the finance ledger; the
 * OTP and Mojaloop interop channels are fail-closed driver ports (stub
 * default, live env-gated).
 */
@Module({
  imports: [FinanceModule, IntegrationsModule, UsersModule],
  controllers: [AgentBankingController, AgentUssdController],
  providers: [
    AgentBankingService,
    AgentUssdService,
    { provide: OTP_DRIVER_TOKEN, useFactory: () => createOtpDriver(process.env) }
  ],
  exports: [AgentBankingService, AgentUssdService, OTP_DRIVER_TOKEN]
})
export class AgentBankingModule {}
