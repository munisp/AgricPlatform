import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min
} from 'class-validator';
import type { BookingStatus, ServiceCategory, User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Public, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import {
  ServicesMarketplaceService,
  type CreateOfferingInput
} from './services-marketplace.service.js';

const SERVICE_CATEGORIES: ServiceCategory[] = [
  'mechanisation',
  'spraying',
  'transport',
  'storage',
  'processing',
  'veterinary',
  'extension'
];

class ListOfferingsQuery extends ListQueryDto {
  @IsOptional()
  @IsIn(SERVICE_CATEGORIES)
  category?: ServiceCategory;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;
}

class CreateOfferingDto implements CreateOfferingInput {
  @IsIn(SERVICE_CATEGORIES)
  category!: ServiceCategory;

  @IsString()
  @MaxLength(200)
  title!: string;

  @IsString()
  @MaxLength(2000)
  description!: string;

  @IsInt()
  @Min(0)
  priceNaira!: number;

  @IsString()
  @MaxLength(100)
  unit!: string;

  @IsString()
  @MaxLength(100)
  state!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  lgas?: string[];
}

class CreateBookingDto {
  @IsString()
  @MaxLength(100)
  requesterId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

class BookingStatusDto {
  @IsIn(['requested', 'accepted', 'in_progress', 'completed', 'cancelled', 'disputed'])
  status!: BookingStatus;
}

/**
 * Services marketplace (mechanisation, spraying, transport...). Offerings
 * are a public catalogue; bookings are personal records visible to the
 * requester, the provider or an admin, with the state machine enforced in
 * the service.
 */
@ApiTags('services-marketplace')
@Controller()
@UseGuards(RolesGuard)
export class ServicesMarketplaceController {
  constructor(private readonly services: ServicesMarketplaceService) {}

  @Get('service-offerings')
  @Public()
  @ApiOperation({ summary: 'Browse service offerings (public catalogue)' })
  listOfferings(@Query() query: ListOfferingsQuery) {
    return this.services.listOfferings(query);
  }

  @Post('service-offerings')
  @Authenticated()
  @ApiOperation({ summary: 'Publish a service offering (provider is the authenticated user)' })
  async createOffering(@Body() dto: CreateOfferingDto, @CurrentUser() actor: User | null) {
    return { data: await this.services.createOffering(dto, actor!.id) };
  }

  @Get('service-offerings/:id')
  @Public()
  @ApiOperation({ summary: 'Service offering detail (public catalogue)' })
  async getOffering(@Param('id') id: string) {
    return { data: await this.services.getOffering(id) };
  }

  @Post('service-offerings/:id/bookings')
  @Authenticated()
  @ApiOperation({ summary: 'Request a booking on an offering (own request or admin)' })
  async createBooking(
    @Param('id') id: string,
    @Body() dto: CreateBookingDto,
    @CurrentUser() actor: User | null
  ) {
    assertSelfOrAdmin(actor, dto.requesterId);
    return { data: await this.services.createBooking(id, dto, actor!) };
  }

  @Get('service-bookings')
  @Authenticated()
  @ApiOperation({ summary: 'List bookings (requester/provider scoped; admins see all)' })
  async listBookings(
    @CurrentUser() actor: User | null,
    @Query('requesterId') requesterId?: string,
    @Query('providerId') providerId?: string,
    @Query('status') status?: BookingStatus
  ) {
    if (requesterId) {
      assertSelfOrAdmin(actor, requesterId);
    }
    if (providerId) {
      assertSelfOrAdmin(actor, providerId);
    }
    if (!requesterId && !providerId && !actor?.roles.includes('admin')) {
      throw new ForbiddenException('Listing bookings across users requires the admin role');
    }
    return { data: await this.services.listBookings({ requesterId, providerId, status }) };
  }

  @Get('service-bookings/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Booking detail (requester, provider or admin)' })
  async getBooking(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const booking = await this.services.getBooking(id);
    if (!actor?.roles.includes('admin')) {
      if (actor?.id !== booking.requesterId && actor?.id !== booking.providerId) {
        throw new ForbiddenException('Bookings are visible to the requester, the provider or an admin');
      }
    }
    return { data: booking };
  }

  @Patch('service-bookings/:id/status')
  @Authenticated()
  @ApiOperation({ summary: 'Advance a booking status (actor-checked state machine in the service)' })
  async setBookingStatus(
    @Param('id') id: string,
    @Body() dto: BookingStatusDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.services.transitionBooking(id, dto.status, actor!) };
  }
}
