import { Module } from '@nestjs/common';
import { SyncModule } from '../sync/sync.module.js';
import { CommerceController } from './commerce.controller.js';
import { EscrowService, PAYMENT_PROVIDER } from './escrow.service.js';
import { InvoiceService } from './invoice.service.js';
import { LogisticsService } from './logistics.service.js';
import { MarketplaceController } from './marketplace.controller.js';
import { MarketplaceService } from './marketplace.service.js';
import { createMarketplacePaymentProvider } from './payment-provider.js';

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
    }
  ],
  exports: [MarketplaceService, EscrowService, InvoiceService, LogisticsService]
})
export class MarketplaceModule {}
