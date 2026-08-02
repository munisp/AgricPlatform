import { Module } from '@nestjs/common';
import { MarketplaceModule } from '../marketplace/marketplace.module.js';
import { BuyerGroupsService } from './buyer-groups.service.js';
import { CheckoutService } from './checkout.service.js';
import { CommerceController } from './commerce.controller.js';
import { DraftOrdersService } from './draft-orders.service.js';
import { OrderOpsService } from './order-ops.service.js';
import { PricingService } from './pricing.service.js';
import { ProductReviewsService } from './product-reviews.service.js';
import { PromotionsService } from './promotions.service.js';
import { ReturnsService } from './returns.service.js';
import { SellerAnalyticsService } from './seller-analytics.service.js';
import { VariantsService } from './variants.service.js';

/**
 * Wave M marketplace commerce depth (Medusa-pattern innovations adopted
 * natively). Imports MarketplaceModule for the guarded escrow/order
 * collaborators (RMA refunds, cancel-with-restock state transitions).
 */
@Module({
  imports: [MarketplaceModule],
  controllers: [CommerceController],
  providers: [
    VariantsService,
    CheckoutService,
    BuyerGroupsService,
    PricingService,
    PromotionsService,
    OrderOpsService,
    ReturnsService,
    DraftOrdersService,
    ProductReviewsService,
    SellerAnalyticsService
  ],
  exports: [
    VariantsService,
    BuyerGroupsService,
    PricingService,
    PromotionsService,
    ProductReviewsService,
    SellerAnalyticsService
  ]
})
export class CommerceModule {}
