import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
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
  type OrderStatus
} from '@agric-platform/shared';
import { ActorId } from '../../common/auth/current-user.decorator.js';
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
  @ApiOperation({ summary: 'Create a produce/input/service listing' })
  createListing(@Body() dto: CreateListingDto) {
    return { data: this.marketplace.createListing(dto) };
  }

  @Get('listings/:id')
  @ApiOperation({ summary: 'Listing detail' })
  getListing(@Param('id') id: string) {
    return { data: this.marketplace.getListing(id) };
  }

  @Patch('listings/:id')
  @ApiOperation({ summary: 'Update a listing (price, quantity, active state)' })
  updateListing(@Param('id') id: string, @Body() dto: UpdateListingDto, @ActorId() actorId: string) {
    return { data: this.marketplace.updateListing(id, dto, actorId) };
  }

  @Post('listings/:id/orders')
  @ApiOperation({ summary: 'Place an order against a listing (escrow-ready above threshold)' })
  placeOrder(@Param('id') id: string, @Body() dto: CreateOrderDto) {
    return { data: this.marketplace.placeOrder(id, dto.buyerId, dto.quantity) };
  }

  @Get('orders')
  @ApiOperation({ summary: 'List orders by buyer, seller or status' })
  listOrders(
    @Query('buyerId') buyerId?: string,
    @Query('sellerId') sellerId?: string,
    @Query('status') status?: OrderStatus
  ) {
    return { data: this.marketplace.listOrders({ buyerId, sellerId, status }) };
  }

  @Get('orders/:id')
  @ApiOperation({ summary: 'Order detail' })
  getOrder(@Param('id') id: string) {
    return { data: this.marketplace.getOrder(id) };
  }

  @Patch('orders/:id/status')
  @ApiOperation({ summary: 'Transition an order status (fulfilment workflow)' })
  setOrderStatus(@Param('id') id: string, @Body() dto: OrderStatusDto, @ActorId() actorId: string) {
    const order = this.marketplace.setOrderStatus(id, dto.status, actorId);
    this.audit.record({
      actorId,
      action: 'order.status_changed',
      entityType: 'order',
      entityId: id,
      metadata: { status: dto.status }
    });
    return { data: order };
  }

  @Post('orders/:id/reviews')
  @ApiOperation({ summary: 'Review a delivered/completed order' })
  reviewOrder(@Param('id') id: string, @Body() dto: ReviewDto) {
    return { data: this.marketplace.reviewOrder(id, dto.authorId, dto.rating, dto.comment) };
  }

  @Get('orders/:id/reviews')
  @ApiOperation({ summary: 'Reviews for an order' })
  reviews(@Param('id') id: string) {
    return { data: this.marketplace.reviewsForOrder(id) };
  }
}
