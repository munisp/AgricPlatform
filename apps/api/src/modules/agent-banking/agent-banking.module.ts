import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { UsersModule } from '../users/users.module.js';
import { AgentBankingController, AgentUssdController } from './agent-banking.controller.js';
import { AgentBankingService } from './agent-banking.service.js';
import { AgentUssdService } from './agent-ussd.service.js';
// Stage 27 Innovation 16 (DEALER QR PAY, additive): HMAC-signed merchant QR
// codes + Mojaloop merchant payments with signed-voucher co-pay, flag-gated
// behind `dealer-qr-pay` (default OFF).
import { DealerQrController, DealerQrWebhookController } from './dealer-qr.controller.js';
import { DealerQrService } from './dealer-qr.service.js';
import { OTP_DRIVER_TOKEN, createOtpDriver } from './otp.driver.js';
// Dealer QR Pay persistence wiring lives here (not in the shared global
// DatabaseModule) to keep the change strictly additive within the module:
// pg when PG_POOL is live, in-memory otherwise — the same factory shape the
// DatabaseModule uses.
import type pg from 'pg';
import {
  MERCHANT_PAYMENT_REPOSITORY,
  MERCHANT_QR_CODE_REPOSITORY,
  PG_POOL
} from '../../database/persistence.tokens.js';
import {
  createInMemoryMerchantPaymentRepository,
  createInMemoryMerchantQrCodeRepository
} from '../../database/repositories/dealer-qr.repository.js';
import {
  createPgMerchantPaymentRepository,
  createPgMerchantQrCodeRepository
} from '../../database/repositories/dealer-qr.pg-repository.js';

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
  controllers: [AgentBankingController, AgentUssdController, DealerQrController, DealerQrWebhookController],
  providers: [
    AgentBankingService,
    AgentUssdService,
    DealerQrService,
    {
      provide: MERCHANT_QR_CODE_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgMerchantQrCodeRepository(pool) : createInMemoryMerchantQrCodeRepository(),
      inject: [PG_POOL]
    },
    {
      provide: MERCHANT_PAYMENT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgMerchantPaymentRepository(pool) : createInMemoryMerchantPaymentRepository(),
      inject: [PG_POOL]
    },
    { provide: OTP_DRIVER_TOKEN, useFactory: () => createOtpDriver(process.env) }
  ],
  exports: [AgentBankingService, AgentUssdService, DealerQrService, OTP_DRIVER_TOKEN]
})
export class AgentBankingModule {}
