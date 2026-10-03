import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min
} from 'class-validator';
import { Transform } from 'class-transformer';
import {
  LISTING_KINDS,
  ORDER_STATUSES,
  type ListingKind,
  type MarketplaceListing,
  type Order,
  type OrderStatus,
  type User
} from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Public, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import { AuditService } from '../../core/audit.service.js';
import {
  MarketplaceService,
  type CreateListingInput,
  type PlaceOrderInput
} from './marketplace.service.js';

class ListListingsQuery extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @IsIn(LISTING_KINDS)
  kind?: ListingKind;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  crop?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  sellerId?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  active?: boolean;
}

class CreateListingDto implements CreateListingInput {
  @IsIn(LISTING_KINDS)
  kind!: ListingKind;

  @IsString()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  crop?: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsString()
  @MaxLength(100)
  unit!: string;

  @IsInt()
  @Min(0)
  priceNaira!: number;

  @IsString()
  @MaxLength(100)
  state!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lga?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  harvestDate?: string;
}

class PlaceOrderDto implements PlaceOrderInput {
  @IsString()
  @MaxLength(100)
  buyerId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

class OrderStatusDto {
  @IsIn(ORDER_STATUSES)
  status!: OrderStatus;
}

/**
 * Marketplace listings are a public browse catalogue (no PII beyond the
 * seller-facing fields the catalogue itself needs). Listing management is
 * owner-only; orders are personal trade records visible to buyer, seller
 * or admin. Order status transitions are actor-checked in the service.
 */
@ApiTags('marketplace')
@Controller()
@UseGuards(RolesGuard)
export class MarketplaceController {
  constructor(
    private readonly marketplace: MarketplaceService,
    private readonly audit: AuditService
  ) {}

  @Get('listings')
  @Public()
  @ApiOperation({ summary: 'Browse marketplace listings (public catalogue, paginated)' })
  listListings(@Query() query: ListListingsQuery) {
    return this.marketplace.listListings(query);
  }

  @Post('listings')
  @Authenticated()
  @ApiOperation({ summary: 'Create a listing (seller is the authenticated user)' })
  async createListing(@Body() dto: CreateListingDto, @CurrentUser() actor: User | null) {
    return { data: await this.marketplace.createListing(dto, actor!.id) };
  }

  @Get('listings/:id')
  @Public()
  @ApiOperation({ summary: 'Listing detail (public catalogue)' })
  async getListing(@Param('id') id: string) {
    return { data: await this.marketplace.getListing(id) };
  }

  @Patch('listings/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Update a listing (owning seller or admin)' })
  async updateListing(
    @Param('id') id: string,
    @Body() dto: Partial<CreateListingDto>,
    @CurrentUser() actor: User | null
  ) {
    const listing = await this.marketplace.getListing(id);
    assertSelfOrAdmin(actor, listing.sellerId);
    return { data: await this.marketplace.updateListing(id, dto, actor!) };
  }

  @Post('listings/:id/orders')
  @Authenticated()
  @ApiOperation({ summary: 'Place an order on a listing (buyer is a registered user; idempotency-keyed)' })
  async placeOrder(
    @Param('id') id: string,
    @Body() dto: PlaceOrderDto,
    @CurrentUser() actor: User | null
  ) {
    assertSelfOrAdmin(actor, dto.buyerId);
    return { data: await this.marketplace.placeOrder(id, dto, actor!) };
  }

  @Get('orders')
  @Authenticated()
  @ApiOperation({ summary: 'List orders (buyer/seller scoped; admins see all)' })
  async listOrders(
    @CurrentUser() actor: User | null,
    @Query('buyerId') buyerId?: string,
    @Query('sellerId') sellerId?: string,
    @Query('status') status?: OrderStatus
  ) {
    if (buyerId) {
      assertSelfOrAdmin(actor, buyerId);
    }
    if (sellerId) {
      assertSelfOrAdmin(actor, sellerId);
    }
    if (!buyerId && !sellerId && !actor?.roles.includes('admin')) {
      throw new ForbiddenException('Listing orders across users requires the admin role');
    }
    return { data: await this.marketplace.listOrders({ buyerId, sellerId, status }) };
  }

  @Get('orders/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Order detail (buyer, seller or admin)' })
  async getOrder(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const order = await this.marketplace.getOrder(id);
    if (!actor?.roles.includes('admin')) {
      if (actor?.id !== order.buyerId && actor?.id !== order.sellerId) {
        throw new ForbiddenException('Orders are visible to the buyer, the seller or an admin');
      }
    }
    return { data: order };
  }

  @Post('orders/:id/status')
  @Authenticated()
  @ApiOperation({ summary: 'Advance an order status (actor-checked state machine in the service)' })
  async setOrderStatus(
    @Param('id') id: string,
    @Body() dto: OrderStatusDto,
    @CurrentUser() actor: User | null
  ) {
    const updated = await this.marketplace.transitionOrder(id, dto.status, actor!);
    await this.audit.record({
      actorId: actor?.id ?? 'anonymous',
      action: 'order.status_changed',
      entityType: 'order',
      entityId: id,
      metadata: { status: dto.status }
    });
    return { data: updated };
  }
}
