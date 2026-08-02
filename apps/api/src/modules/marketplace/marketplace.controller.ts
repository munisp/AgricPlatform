import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested
} from 'class-validator';
import {
  ORDER_STATUSES,
  type LocationRef,
  type MarketplaceListing,
  type OrderStatus,
  type User
} from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertPartyOrAdmin, assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import { AuditService } from '../../core/audit.service.js';
import {
  MarketplaceService,
  type CreateListingInput,
  type UpdateListingInput
} from './marketplace.service.js';

const LISTING_KINDS = ['produce', 'input', 'service', 'equipment', 'storage', 'transport'] as const;

class ListListingsQuery extends ListQueryDto {
  @IsOptional()
  @IsIn(LISTING_KINDS)
  kind?: MarketplaceListing['kind'];

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  crop?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  active?: boolean;
}

class LocationDto implements LocationRef {
  @IsString()
  state!: string;

  @IsString()
  lga!: string;

  @IsOptional()
  @IsString()
  ward?: string;
}

class CreateListingDto implements CreateListingInput {
  @IsString()
  sellerId!: string;

  @IsIn(LISTING_KINDS)
  kind!: MarketplaceListing['kind'];

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  crop?: string;

  @IsNumber()
  @Min(1)
  quantity!: number;

  @IsString()
  unit!: string;

  @IsNumber()
  @Min(1)
  priceNaira!: number;

  @ValidateNested()
  @Type(() => LocationDto)
  location!: LocationDto;

  @IsOptional()
  @IsString()
  harvestDate?: string;
}

class UpdateListingDto implements UpdateListingInput {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  priceNaira?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class CreateOrderDto {
  @IsString()
  buyerId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

class OrderStatusDto {
  @IsIn(ORDER_STATUSES)
  status!: OrderStatus;
}

class ReviewDto {
  @IsString()
  authorId!: string;

  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  comment?: string;
}

@ApiTags('marketplace')
@Controller()
export class MarketplaceController {
  constructor(
    private readonly marketplace: MarketplaceService,
    private readonly audit: AuditService
  ) {}

  @Get('listings')
  @ApiOperation({ summary: 'List marketplace listings with filters' })
  listListings(@Query() query: ListListingsQuery) {
    return this.marketplace.listListings(query);
  }

  @Post('listings')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Create a produce/input/service listing' })
  async createListing(@Body() dto: CreateListingDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.sellerId);
    return { data: await this.marketplace.createListing(dto) };
  }

  @Get('listings/:id')
  @ApiOperation({ summary: 'Listing detail' })
  async getListing(@Param('id') id: string) {
    return { data: await this.marketplace.getListing(id) };
  }

  @Patch('listings/:id')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Update a listing (price, quantity, active state)' })
  async updateListing(
    @Param('id') id: string,
    @Body() dto: UpdateListingDto,
    @CurrentUser() actor: User | null
  ) {
    const listing = await this.marketplace.getListing(id);
    const owner = assertSelfOrAdmin(actor, listing.sellerId);
    return { data: await this.marketplace.updateListing(id, dto, owner.id) };
  }

  @Post('listings/:id/orders')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Place an order against a listing (escrow-ready above threshold)' })
  async placeOrder(@Param('id') id: string, @Body() dto: CreateOrderDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.buyerId);
    return { data: await this.marketplace.placeOrder(id, dto.buyerId, dto.quantity) };
  }

  @Get('orders')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'List orders by buyer, seller or status (own records or admin)' })
  async listOrders(
    @CurrentUser() actor: User | null,
    @Query('buyerId') buyerId?: string,
    @Query('sellerId') sellerId?: string,
    @Query('status') status?: OrderStatus
  ) {
    if (!actor) {
      throw new UnauthorizedException('Authentication required');
    }
    if (!actor.roles.includes('admin') && buyerId !== actor.id && sellerId !== actor.id) {
      assertSelfOrAdmin(actor, buyerId ?? sellerId ?? '');
    }
    return { data: await this.marketplace.listOrders({ buyerId, sellerId, status }) };
  }

  @Get('orders/:id')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Order detail (order parties or admin)' })
  async getOrder(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const order = await this.marketplace.getOrder(id);
    assertPartyOrAdmin(actor, [order.buyerId, order.sellerId]);
    return { data: order };
  }

  @Patch('orders/:id/status')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Transition an order status (state machine enforced, actor-scoped)' })
  async setOrderStatus(
    @Param('id') id: string,
    @Body() dto: OrderStatusDto,
    @CurrentUser() actor: User | null
  ) {
    if (!actor) {
      throw new UnauthorizedException('Authentication required for order transitions');
    }
    const order = await this.marketplace.setOrderStatus(id, dto.status, actor);
    await this.audit.record({
      actorId: actor.id,
      action: 'order.status_changed',
      entityType: 'order',
      entityId: id,
      metadata: { status: dto.status }
    });
    return { data: order };
  }

  @Post('orders/:id/reviews')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Review a delivered/completed order' })
  async reviewOrder(@Param('id') id: string, @Body() dto: ReviewDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.authorId);
    return { data: await this.marketplace.reviewOrder(id, dto.authorId, dto.rating, dto.comment) };
  }

  @Get('orders/:id/reviews')
  @ApiOperation({ summary: 'Reviews for an order' })
  async reviews(@Param('id') id: string) {
    return { data: await this.marketplace.reviewsForOrder(id) };
  }
}
