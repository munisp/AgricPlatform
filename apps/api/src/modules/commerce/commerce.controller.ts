import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min
} from 'class-validator';
import {
  RETURN_STATUSES,
  SALES_CHANNELS,
  type ReturnStatus,
  type SalesChannel,
  type User
} from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertPartyOrAdmin, assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { MarketplaceService } from '../marketplace/marketplace.service.js';
import { BuyerGroupsService, type CreateBuyerGroupInput, type UpdateBuyerGroupInput } from './buyer-groups.service.js';
import { CheckoutService, type CheckoutInput } from './checkout.service.js';
import { DraftOrdersService, type CreateDraftOrderInput } from './draft-orders.service.js';
import { OrderOpsService } from './order-ops.service.js';
import { PricingService, type CreatePriceListInput } from './pricing.service.js';
import { ProductReviewsService } from './product-reviews.service.js';
import { PromotionsService, type CreatePromotionInput } from './promotions.service.js';
import { ReturnsService } from './returns.service.js';
import { SellerAnalyticsService } from './seller-analytics.service.js';
import { VariantsService, type CreateVariantInput, type UpdateVariantInput } from './variants.service.js';

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

/* --------------------------------- DTOs --------------------------------- */

class CreateVariantDto implements CreateVariantInput {
  @IsString()
  sku!: string;

  @IsString()
  name!: string;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;

  @IsInt()
  @Min(0)
  priceKobo!: number;

  @IsInt()
  @Min(0)
  quantity!: number;
}

class UpdateVariantDto implements UpdateVariantInput {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceKobo?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class CheckoutDto {
  @IsString()
  listingId!: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsString()
  buyerId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsString()
  promotionCode?: string;

  @IsOptional()
  @IsIn(SALES_CHANNELS)
  channel?: SalesChannel;
}

class CreateBuyerGroupDto implements CreateBuyerGroupInput {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;
}

class UpdateBuyerGroupDto implements UpdateBuyerGroupInput {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class MembershipDto {
  @IsString()
  userId!: string;
}

class CreatePriceListDto implements CreatePriceListInput {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  buyerGroupId?: string;

  @IsOptional()
  @IsString()
  startsAt?: string;

  @IsOptional()
  @IsString()
  endsAt?: string;

  @IsOptional()
  @IsInt()
  priority?: number;
}

class UpdatePriceListDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  buyerGroupId?: string | null;

  @IsOptional()
  startsAt?: string | null;

  @IsOptional()
  endsAt?: string | null;

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class PriceListEntryDto {
  @IsString()
  variantId!: string;

  @IsInt()
  @Min(0)
  priceKobo!: number;
}

class CreatePromotionDto implements CreatePromotionInput {
  @IsOptional()
  @IsString()
  code?: string;

  @IsString()
  name!: string;

  @IsIn(['percentage', 'fixed'])
  kind!: 'percentage' | 'fixed';

  @IsInt()
  @Min(1)
  value!: number;

  @IsOptional()
  @IsBoolean()
  automatic?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  minOrderKobo?: number;

  @IsOptional()
  @IsString()
  listingId?: string;

  @IsOptional()
  @IsString()
  buyerGroupId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimit?: number;

  @IsOptional()
  @IsString()
  startsAt?: string;

  @IsOptional()
  @IsString()
  endsAt?: string;
}

class UpdatePromotionDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  value?: number;

  @IsOptional()
  minOrderKobo?: number | null;

  @IsOptional()
  listingId?: string | null;

  @IsOptional()
  buyerGroupId?: string | null;

  @IsOptional()
  usageLimit?: number | null;

  @IsOptional()
  startsAt?: string | null;

  @IsOptional()
  endsAt?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class EvaluatePromotionDto {
  @IsString()
  listingId!: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsString()
  buyerId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsString()
  promotionCode?: string;
}

class EditOrderDto {
  @IsInt()
  @Min(1)
  quantity!: number;
}

class CreateReturnDto {
  @IsString()
  buyerId!: string;

  @IsString()
  reason!: string;

  @IsOptional()
  @IsBoolean()
  restock?: boolean;
}

class ReturnTransitionDto {
  @IsIn(RETURN_STATUSES)
  status!: ReturnStatus;
}

class CreateDraftOrderDto implements CreateDraftOrderInput {
  @IsString()
  listingId!: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsString()
  buyerId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

class CreateProductReviewDto {
  @IsString()
  orderId!: string;

  @IsString()
  buyerId!: string;

  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  comment?: string;
}

/* ------------------------------ controller ------------------------------ */

@ApiTags('commerce')
@Controller()
@UseGuards(RolesGuard)
export class CommerceController {
  constructor(
    private readonly variants: VariantsService,
    private readonly checkout: CheckoutService,
    private readonly buyerGroups: BuyerGroupsService,
    private readonly pricing: PricingService,
    private readonly promotions: PromotionsService,
    private readonly orderOps: OrderOpsService,
    private readonly returns: ReturnsService,
    private readonly drafts: DraftOrdersService,
    private readonly reviews: ProductReviewsService,
    private readonly analytics: SellerAnalyticsService,
    private readonly marketplace: MarketplaceService
  ) {}

  /* ------------------------- 1. variants & SKUs ------------------------- */

  @Get('listings/:id/variants')
  @ApiOperation({ summary: 'List variants for a listing' })
  async listVariants(@Param('id') id: string, @Query('active') active?: string) {
    return { data: await this.variants.listForListing(id, active === 'true') };
  }

  @Post('listings/:id/variants')
  @Authenticated()
  @ApiOperation({ summary: 'Add a variant (SKU + price + stock) to a listing (seller/admin)' })
  async createVariant(@Param('id') id: string, @Body() dto: CreateVariantDto, @CurrentUser() actor: User | null) {
    return { data: await this.variants.createVariant(id, dto, requireActor(actor)) };
  }

  @Patch('variants/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Update a variant (price, stock, active state) (seller/admin)' })
  async updateVariant(@Param('id') id: string, @Body() dto: UpdateVariantDto, @CurrentUser() actor: User | null) {
    return { data: await this.variants.updateVariant(id, dto, requireActor(actor)) };
  }

  /* ----------------------------- checkout ------------------------------- */

  @Post('checkout/preview')
  @Authenticated()
  @ApiOperation({ summary: 'Preview a checkout: resolved unit price + promotion evaluation' })
  async preview(@Body() dto: EvaluatePromotionDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.buyerId);
    return {
      data: await this.checkout.preview({
        listingId: dto.listingId,
        variantId: dto.variantId,
        buyerId: dto.buyerId,
        quantity: dto.quantity,
        promotionCode: dto.promotionCode
      })
    };
  }

  @Post('checkout/orders')
  @Authenticated()
  @ApiOperation({ summary: 'Place an order on a listing/variant with promotions + sales channel' })
  async placeOrder(@Body() dto: CheckoutDto, @CurrentUser() actor: User | null) {
    const user = requireActor(actor);
    assertSelfOrAdmin(user, dto.buyerId);
    const input: CheckoutInput = { ...dto, channel: dto.channel ?? 'web' };
    return { data: await this.checkout.placeOrder(input, user) };
  }

  /* ---------------------------- 4. buyer groups ------------------------- */

  @Get('buyer-groups')
  @Authenticated()
  @ApiOperation({ summary: 'List buyer groups' })
  async listBuyerGroups() {
    return { data: await this.buyerGroups.listGroups() };
  }

  @Post('buyer-groups')
  @Authenticated()
  @ApiOperation({ summary: 'Create a buyer group (admin/agent)' })
  async createBuyerGroup(@Body() dto: CreateBuyerGroupDto, @CurrentUser() actor: User | null) {
    return { data: await this.buyerGroups.createGroup(dto, requireActor(actor)) };
  }

  @Patch('buyer-groups/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Update a buyer group (admin/agent)' })
  async updateBuyerGroup(@Param('id') id: string, @Body() dto: UpdateBuyerGroupDto, @CurrentUser() actor: User | null) {
    return { data: await this.buyerGroups.updateGroup(id, dto, requireActor(actor)) };
  }

  @Get('buyer-groups/:id/members')
  @Authenticated()
  @ApiOperation({ summary: 'List buyer group members' })
  async listMembers(@Param('id') id: string) {
    return { data: await this.buyerGroups.listMembers(id) };
  }

  @Post('buyer-groups/:id/members')
  @Authenticated()
  @ApiOperation({ summary: 'Add a buyer to a group (admin/agent)' })
  async addMember(@Param('id') id: string, @Body() dto: MembershipDto, @CurrentUser() actor: User | null) {
    return { data: await this.buyerGroups.addMember(id, dto.userId, requireActor(actor)) };
  }

  @Delete('buyer-groups/:id/members/:userId')
  @Authenticated()
  @ApiOperation({ summary: 'Remove a buyer from a group (admin/agent)' })
  async removeMember(@Param('id') id: string, @Param('userId') userId: string, @CurrentUser() actor: User | null) {
    await this.buyerGroups.removeMember(id, userId, requireActor(actor));
    return { data: { removed: true } };
  }

  /* ----------------------------- 3. price lists ------------------------- */

  @Get('price-lists')
  @Authenticated()
  @ApiOperation({ summary: 'List price lists' })
  async listPriceLists() {
    return { data: await this.pricing.listPriceLists() };
  }

  @Post('price-lists')
  @Authenticated()
  @ApiOperation({ summary: 'Create a price list (admin/agent)' })
  async createPriceList(@Body() dto: CreatePriceListDto, @CurrentUser() actor: User | null) {
    return { data: await this.pricing.createPriceList(dto, requireActor(actor)) };
  }

  @Patch('price-lists/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Update a price list (admin/agent)' })
  async updatePriceList(@Param('id') id: string, @Body() dto: UpdatePriceListDto, @CurrentUser() actor: User | null) {
    return { data: await this.pricing.updatePriceList(id, dto, requireActor(actor)) };
  }

  @Get('price-lists/:id/entries')
  @Authenticated()
  @ApiOperation({ summary: 'List price list entries' })
  async listPriceListEntries(@Param('id') id: string) {
    return { data: await this.pricing.listEntries(id) };
  }

  @Post('price-lists/:id/entries')
  @Authenticated()
  @ApiOperation({ summary: 'Set (upsert) a variant price in a price list (admin/agent)' })
  async setPriceListEntry(@Param('id') id: string, @Body() dto: PriceListEntryDto, @CurrentUser() actor: User | null) {
    return { data: await this.pricing.setEntry(id, dto.variantId, dto.priceKobo, requireActor(actor)) };
  }

  /* ----------------------------- 2. promotions -------------------------- */

  @Get('promotions')
  @Authenticated()
  @ApiOperation({ summary: 'List promotions' })
  async listPromotions() {
    return { data: await this.promotions.listPromotions() };
  }

  @Post('promotions')
  @Authenticated()
  @ApiOperation({ summary: 'Create a promotion / coupon code (admin/agent)' })
  async createPromotion(@Body() dto: CreatePromotionDto, @CurrentUser() actor: User | null) {
    return { data: await this.promotions.createPromotion(dto, requireActor(actor)) };
  }

  @Patch('promotions/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Update a promotion (admin/agent)' })
  async updatePromotion(@Param('id') id: string, @Body() dto: UpdatePromotionDto, @CurrentUser() actor: User | null) {
    return { data: await this.promotions.updatePromotion(id, dto, requireActor(actor)) };
  }

  @Get('orders/:id/promotions')
  @Authenticated()
  @ApiOperation({ summary: 'Promotions applied to an order (order parties or admin)' })
  async orderPromotions(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const user = requireActor(actor);
    const order = await this.marketplace.getOrder(id);
    assertPartyOrAdmin(user, [order.buyerId, order.sellerId]);
    return { data: await this.promotions.redemptionsForOrder(id) };
  }

  /* --------------------- 5. order edit & cancel-restock ----------------- */

  @Post('orders/:id/edit')
  @Authenticated()
  @ApiOperation({ summary: 'Edit an order quantity before fulfilment (buyer/admin), recalculating totals' })
  async editOrder(@Param('id') id: string, @Body() dto: EditOrderDto, @CurrentUser() actor: User | null) {
    return { data: await this.orderOps.editQuantity(id, dto.quantity, requireActor(actor)) };
  }

  @Post('orders/:id/cancel')
  @Authenticated()
  @ApiOperation({ summary: 'Cancel an order with atomic restock (guarded transition)' })
  async cancelOrder(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.orderOps.cancelWithRestock(id, requireActor(actor)) };
  }

  /* ------------------------------ 6. returns ---------------------------- */

  @Post('orders/:id/returns')
  @Authenticated()
  @ApiOperation({ summary: 'Request a return on a fulfilled order (buyer)' })
  async requestReturn(@Param('id') id: string, @Body() dto: CreateReturnDto, @CurrentUser() actor: User | null) {
    const user = requireActor(actor);
    return { data: await this.returns.requestReturn(id, dto.buyerId, dto.reason, dto.restock ?? false, user) };
  }

  @Get('returns')
  @Authenticated()
  @ApiOperation({ summary: 'List return requests (filtered by order/buyer/status)' })
  async listReturns(
    @CurrentUser() actor: User | null,
    @Query('orderId') orderId?: string,
    @Query('buyerId') buyerId?: string,
    @Query('status') status?: ReturnStatus
  ) {
    const user = requireActor(actor);
    // Party scoping lives in the service (it owns the order lookup):
    // non-admins default to buyerId=self and cross-party orderIds 403.
    return { data: await this.returns.listReturns({ orderId, buyerId, status }, user) };
  }

  @Post('returns/:id/transition')
  @Authenticated()
  @ApiOperation({ summary: 'Drive the RMA state machine (approved/received/refunded/rejected)' })
  async transitionReturn(@Param('id') id: string, @Body() dto: ReturnTransitionDto, @CurrentUser() actor: User | null) {
    return { data: await this.returns.transition(id, dto.status, requireActor(actor)) };
  }

  /* ---------------------------- 7. draft orders ------------------------- */

  @Get('draft-orders')
  @Authenticated()
  @ApiOperation({ summary: 'List draft orders (buyer/seller/status filter)' })
  async listDrafts(
    @CurrentUser() actor: User | null,
    @Query('buyerId') buyerId?: string,
    @Query('sellerId') sellerId?: string,
    @Query('status') status?: 'open' | 'confirmed' | 'discarded'
  ) {
    const user = requireActor(actor);
    if (!user.roles.includes('admin')) {
      if (buyerId && buyerId !== user.id && sellerId !== user.id) {
        assertSelfOrAdmin(user, buyerId);
      }
      if (!buyerId && !sellerId) {
        buyerId = user.id;
      }
    }
    return { data: await this.drafts.listDrafts({ buyerId, sellerId, status }) };
  }

  @Post('draft-orders')
  @Authenticated()
  @ApiOperation({ summary: 'Create a draft order on behalf of a buyer (admin/agent)' })
  async createDraft(@Body() dto: CreateDraftOrderDto, @CurrentUser() actor: User | null) {
    return { data: await this.drafts.createDraft(dto, requireActor(actor)) };
  }

  @Post('draft-orders/:id/confirm')
  @Authenticated()
  @ApiOperation({ summary: 'Buyer confirms a draft order into a normal order (guarded)' })
  async confirmDraft(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.drafts.confirmDraft(id, requireActor(actor)) };
  }

  @Post('draft-orders/:id/discard')
  @Authenticated()
  @ApiOperation({ summary: 'Discard a draft order (buyer/creator/admin)' })
  async discardDraft(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.drafts.discardDraft(id, requireActor(actor)) };
  }

  /* ------------------- 9. verified reviews & ratings -------------------- */

  @Post('listings/:id/reviews')
  @Authenticated()
  @ApiOperation({ summary: 'Review a listing (verified purchase required)' })
  async createReview(@Param('id') id: string, @Body() dto: CreateProductReviewDto, @CurrentUser() actor: User | null) {
    return { data: await this.reviews.createReview(id, dto, requireActor(actor)) };
  }

  @Get('listings/:id/reviews')
  @ApiOperation({ summary: 'Reviews for a listing' })
  async listingReviews(@Param('id') id: string) {
    return { data: await this.reviews.reviewsForListing(id) };
  }

  @Get('sellers/:id/rating')
  @ApiOperation({ summary: 'Materialized seller rating aggregate' })
  async sellerRating(@Param('id') id: string) {
    return { data: await this.reviews.sellerRating(id) };
  }

  /* --------------------------- 10. seller analytics --------------------- */

  @Get('analytics/sellers/:sellerId')
  @Authenticated()
  @ApiOperation({ summary: 'Seller analytics (own numbers or admin)' })
  async sellerAnalytics(@Param('sellerId') sellerId: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, sellerId);
    return { data: await this.analytics.analyticsFor(sellerId) };
  }
}
