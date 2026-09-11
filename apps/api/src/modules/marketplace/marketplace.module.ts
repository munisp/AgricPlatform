import { Module } from '@nestjs/common';
import type pg from 'pg';
import { ESCROW_PAYOUT_REPOSITORY, PG_POOL } from '../../database/persistence.tokens.js';
import { createPgEscrowPayoutRepository } from '../../database/repositories/commerce.pg-repository.js';
import { createInMemoryEscrowPayoutRepository } from '../../database/repositories/payout.repository.js';
import { SyncModule } from '../sync/sync.module.js';
import { CommerceController } from './commerce.controller.js';
import { EscrowService, PAYMENT_PROVIDER } from './escrow.service.js';
import { InvoiceService } from './invoice.service.js';
import { LogisticsService } from './logistics.service.js';
import { MarketplaceController } from './marketplace.controller.js';
import { MarketplaceService } from './marketplace.service.js';
import { createMarketplacePaymentProvider } from './payment-provider.js';
import { createEscrowPayoutDriver, ESCROW_PAYOUT_DRIVER } from './payout.driver.js';

@Module({
  // Wave SYNCSRV: SyncModule provides the (optional) version-bump hook for
  // listing writes. SyncModule imports no feature modules, so no cycle.
  imports: [SyncModule],
  controllers: [MarketplaceController, CommerceController],
  providers: [
    MarketplaceService,
    EscrowService,
    InvoiceService,
    LogisticsService,
    // Stage 22 (audit C2): wire the Paystack/Flutterwave payment driver into
    // the escrow/order path for verify-before-credit. Resolved straight from
    // the environment (the integrations registry lives in IntegrationsModule,
    // which already imports this module — importing it back would cycle).
    // Undefined while PAYMENT_DRIVER is stub/unset; MarketplaceService then
    // refuses deposit_paid in production (fail closed).
    {
      provide: PAYMENT_PROVIDER,
      useFactory: () => createMarketplacePaymentProvider(process.env)
    },
    // Stage 23 (escrow residual): the disbursement rail for release/refund.
    // Default stub outside production (deterministic, labelled, records
    // locally); in production a stub/unset driver makes release/refund fail
    // closed with 503 at use-time (never boot-fatal, mirroring the Stage 22
    // deposit precedent); live validates PAYOUT_PROVIDER_* and still answers
    // 503 until the PSSP disbursement client lands.
    {
      provide: ESCROW_PAYOUT_DRIVER,
      useFactory: () => createEscrowPayoutDriver(process.env)
    },
    // Recorded payout attempts (marketplace.escrow_payouts, migration 048).
    // PG_POOL comes from the global DatabaseModule; falls back to the
    // in-memory repository when no DATABASE_URL is configured.
    {
      provide: ESCROW_PAYOUT_REPOSITORY,
      useFactory: (pool: pg.Pool | null) =>
        pool ? createPgEscrowPayoutRepository(pool) : createInMemoryEscrowPayoutRepository(),
      inject: [PG_POOL]
    }
  ],
  exports: [MarketplaceService, EscrowService, InvoiceService, LogisticsService]
})
export class MarketplaceModule {}
