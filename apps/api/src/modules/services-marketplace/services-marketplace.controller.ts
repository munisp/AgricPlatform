import { Body, Controller, Get, Param, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsISO8601, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import type { BookingStatus, SupplierCategory, User } from '@agric-platform/shared';
import { BOOKING_STATUSES, PRICING_UNITS, SUPPLIER_CATEGORIES, SUPPLIER_VERIFICATION_STATUSES } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import {
  ServicesMarketplaceService,
  type CreateBookingInput,
  type CreateOfferingInput,
  type CreateSupplierInput
} from './services-marketplace.service.js';

class ListSuppliersQuery extends ListQueryDto {
  @IsOptional()
  @IsIn(SUPPLIER_CATEGORIES)
  category?: SupplierCategory;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsIn(SUPPLIER_VERIFICATION_STATUSES)
  verificationStatus?: 'unverified' | 'pending' | 'verified' | 'rejected';
}

class CreateSupplierDto implements CreateSupplierInput {
  @IsString()
  ownerUserId!: string;

  @IsString()
  businessName!: string;

  @IsArray()
  @IsIn(SUPPLIER_CATEGORIES, { each: true })
  categories!: SupplierCategory[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  statesCovered?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  lgasCovered?: string[];
}

class SetVerificationDto {
  @IsIn(SUPPLIER_VERIFICATION_STATUSES)
  verificationStatus!: 'unverified' | 'pending' | 'verified' | 'rejected';
}

class CreateOfferingDto implements Omit<CreateOfferingInput, 'supplierId'> {
  @IsIn(SUPPLIER_CATEGORIES)
  category!: SupplierCategory;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  priceNaira!: number;

  @IsIn(PRICING_UNITS)
  pricingUnit!: CreateOfferingInput['pricingUnit'];
}

class CreateBookingDto implements Omit<CreateBookingInput, 'offeringId'> {
  @IsString()
  customerId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @IsISO8601()
  scheduledStart!: string;

  @IsISO8601()
  scheduledEnd!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

class ListMyBookingsQuery {
  @IsOptional()
  @IsIn(BOOKING_STATUSES)
  status?: BookingStatus;
}

class QuoteBookingDto {
  @IsNumber()
  totalNaira!: number;
}

class SetBookingStatusDto {
  @IsIn(BOOKING_STATUSES)
  status!: BookingStatus;
}

class CreateReviewDto {
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

@ApiTags('services-marketplace')
@Controller()
export class ServicesMarketplaceController {
  constructor(private readonly servicesMarketplace: ServicesMarketplaceService) {}

  @Get('service-suppliers')
  @ApiOperation({ summary: 'List service/input suppliers with category, coverage and verification filters' })
  listSuppliers(@Query() query: ListSuppliersQuery) {
    return this.servicesMarketplace.listSuppliers(query);
  }

  @Post('service-suppliers')
  @UseGuards(RolesGuard)
  @Roles('admin', 'supplier')
  @ApiOperation({ summary: 'Register a supplier profile (suppliers register themselves; admins may register anyone)' })
  async createSupplier(@Body() dto: CreateSupplierDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.ownerUserId);
    return { data: await this.servicesMarketplace.createSupplier(dto) };
  }

  @Get('service-suppliers/:id')
  @ApiOperation({ summary: 'Supplier detail' })
  async getSupplier(@Param('id') id: string) {
    return { data: await this.servicesMarketplace.getSupplier(id) };
  }

  @Post('service-suppliers/:id/verification')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Set supplier verification status (admin only)' })
  async setVerification(@Param('id') id: string, @Body() dto: SetVerificationDto, @CurrentUser() actor: User | null) {
    return { data: await this.servicesMarketplace.setVerificationStatus(id, dto.verificationStatus, actor?.id ?? 'anonymous') };
  }

  @Get('service-suppliers/:id/offerings')
  @ApiOperation({ summary: 'List offerings for a supplier' })
  async listSupplierOfferings(@Param('id') id: string) {
    return { data: await this.servicesMarketplace.listOfferings({ supplierId: id }) };
  }

  @Post('service-suppliers/:id/offerings')
  @UseGuards(RolesGuard)
  @Roles('admin', 'supplier')
  @ApiOperation({ summary: 'Create an offering under a supplier (owner or admin)' })
  async createOffering(@Param('id') id: string, @Body() dto: CreateOfferingDto, @CurrentUser() actor: User | null) {
    return { data: await this.servicesMarketplace.createOffering({ ...dto, supplierId: id }, actor ?? { id: 'anonymous', roles: [] }) };
  }

  @Get('service-offerings')
  @ApiOperation({ summary: 'Browse service offerings (category filter)' })
  async listOfferings(@Query('category') category?: SupplierCategory) {
    return { data: await this.servicesMarketplace.listOfferings({ category, active: true }) };
  }

  @Get('service-offerings/:id')
  @ApiOperation({ summary: 'Offering detail' })
  async getOffering(@Param('id') id: string) {
    return { data: await this.servicesMarketplace.getOffering(id) };
  }

  @Post('service-offerings/:id/bookings')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Request a booking for an offering (own bookings only)' })
  async createBooking(@Param('id') id: string, @Body() dto: CreateBookingDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.customerId);
    return { data: await this.servicesMarketplace.createBooking({ ...dto, offeringId: id }) };
  }

  // Declared before `service-bookings/:id` so 'mine' is not captured as an id.
  @Get('service-bookings/mine')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'List the current user\'s bookings (optional status filter)' })
  async listMyBookings(@Query() query: ListMyBookingsQuery, @CurrentUser() actor: User | null) {
    if (!actor) {
      throw new UnauthorizedException('Authentication required');
    }
    return { data: await this.servicesMarketplace.listBookingsForCustomer(actor.id, query.status) };
  }

  @Get('service-bookings/:id')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Booking detail' })
  async getBooking(@Param('id') id: string) {
    return { data: await this.servicesMarketplace.getBooking(id) };
  }

  @Post('service-bookings/:id/quote')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Supplier quotes a total price for a requested booking' })
  async quoteBooking(@Param('id') id: string, @Body() dto: QuoteBookingDto, @CurrentUser() actor: User | null) {
    return { data: await this.servicesMarketplace.quoteBooking(id, dto.totalNaira, actor ?? { id: 'anonymous', roles: [] }) };
  }

  @Post('service-bookings/:id/status')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Drive the booking state machine (accept/decline/schedule/complete/cancel)' })
  async setBookingStatus(@Param('id') id: string, @Body() dto: SetBookingStatusDto, @CurrentUser() actor: User | null) {
    return { data: await this.servicesMarketplace.setBookingStatus(id, dto.status, actor ?? { id: 'anonymous', roles: [] }) };
  }

  @Post('service-bookings/:id/review')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Review a completed booking (one review per booking, customer only)' })
  async reviewBooking(@Param('id') id: string, @Body() dto: CreateReviewDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.authorId);
    return { data: await this.servicesMarketplace.reviewBooking(id, dto.authorId, dto.rating, dto.comment) };
  }

  @Get('service-suppliers/:id/reviews')
  @ApiOperation({ summary: 'List reviews for a supplier' })
  async listSupplierReviews(@Param('id') id: string) {
    return { data: await this.servicesMarketplace.listSupplierReviews(id) };
  }
}
