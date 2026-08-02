import { Module } from '@nestjs/common';
import { CommerceController } from './commerce.controller.js';
import { EscrowService } from './escrow.service.js';
import { InvoiceService } from './invoice.service.js';
import { LogisticsService } from './logistics.service.js';
import { MarketplaceController } from './marketplace.controller.js';
import { MarketplaceService } from './marketplace.service.js';

@Module({
  controllers: [MarketplaceController, CommerceController],
  providers: [MarketplaceService, EscrowService, InvoiceService, LogisticsService],
  exports: [MarketplaceService, EscrowService, InvoiceService, LogisticsService]
})
export class MarketplaceModule {}
