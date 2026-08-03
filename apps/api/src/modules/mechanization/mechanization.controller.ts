import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested
} from 'class-validator';
import { Type } from 'class-transformer';
import type {
  AvailabilityWindow,
  EquipmentOwnerType,
  EquipmentRates,
  EquipmentType,
  MechBookingStatus,
  OperatorVerificationStatus,
  User
} from '@agric-platform/shared';
import {
  EQUIPMENT_LISTING_STATUSES,
  EQUIPMENT_OWNER_TYPES,
  EQUIPMENT_TYPES,
  MECH_BOOKING_STATUSES,
  OPERATOR_VERIFICATION_STATUSES
} from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import {
  MechanizationService,
  type CreateBookingInput,
  type CreateListingInput
} from './mechanization.service.js';

class AvailabilityWindowDto implements AvailabilityWindow {
  @IsISO8601()
  start!: string;

  @IsISO8601()
  end!: string;
}

class EquipmentRatesDto implements EquipmentRates {
  @IsOptional()
  @IsNumber()
  perHaNaira?: number;

  @IsOptional()
  @IsNumber()
  perHourNaira?: number;

  @IsNumber()
  @Min(0)
  perKmNaira!: number;

  @IsNumber()
  @Min(0)
  includedKm!: number;
}

class CreateListingDto implements Omit<CreateListingInput, 'ownerUserId' | 'rates' | 'availability'> {
  @IsIn(EQUIPMENT_OWNER_TYPES)
  ownerType!: EquipmentOwnerType;

  @IsIn(EQUIPMENT_TYPES)
  type!: EquipmentType;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  specs?: Record<string, unknown>;

  @IsNumber()
  baseLat!: number;

  @IsNumber()
  baseLong!: number;

  @IsInt()
  @Min(5)
  @Max(7)
  serviceAreaResolution!: number;

  @IsInt()
  @Min(0)
  @Max(10)
  serviceAreaRing!: number;

  @ValidateNested()
  @Type(() => EquipmentRatesDto)
  rates!: EquipmentRates;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AvailabilityWindowDto)
  availability!: AvailabilityWindow[];

  @IsOptional()
  @IsString()
  operatorLicenseRef?: string;
}

class SetListingStatusDto {
  @IsIn(EQUIPMENT_LISTING_STATUSES)
  status!: (typeof EQUIPMENT_LISTING_STATUSES)[number];
}

class SetOperatorVerificationDto {
  @IsIn(OPERATOR_VERIFICATION_STATUSES)
  operatorVerification!: OperatorVerificationStatus;
}

class BrowseListingsQuery {
  @IsOptional()
  @IsIn(EQUIPMENT_TYPES)
  type?: EquipmentType;

  @IsOptional()
  @IsString()
  h3Cell?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  lat?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  long?: number;

  @IsOptional()
  @IsISO8601()
  availableFrom?: string;

  @IsOptional()
  @IsISO8601()
  availableTo?: string;
}

class CreateBookingDto implements Omit<CreateBookingInput, 'farmerId'> {
  @IsOptional()
  @IsString()
  plotId?: string;

  @IsNumber()
  plotLat!: number;

  @IsNumber()
  plotLong!: number;

  @IsNumber()
  areaHa!: number;

  @IsOptional()
  @IsNumber()
  estimatedHours?: number;

  @IsISO8601()
  windowStart!: string;

  @IsISO8601()
  windowEnd!: string;
}

class ReasonDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

class ResolveDisputeDto {
  @IsIn(['refund_farmer', 'pay_owner'])
  outcome!: 'refund_farmer' | 'pay_owner';
}

class RateBookingDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  comment?: string;
}

class ListOwnerBookingsQuery {
  @IsOptional()
  @IsIn(MECH_BOOKING_STATUSES)
  status?: MechBookingStatus;
}

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

@ApiTags('mechanization')
@Controller('mechanization')
export class MechanizationController {
  constructor(private readonly mechanization: MechanizationService) {}

  @Get('listings')
  @ApiOperation({ summary: 'Browse active equipment listings (type / service-area / date filters)' })
  browseListings(@Query() query: BrowseListingsQuery) {
    return this.mechanization.browseListings(query).then((data) => ({ data }));
  }

  @Post('listings')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Create an equipment listing (owner = current user, starts DRAFT)' })
  async createListing(@Body() dto: CreateListingDto, @CurrentUser() actor: User | null) {
    const caller = requireActor(actor);
    return {
      data: await this.mechanization.createListing(
        { ...dto, ownerUserId: caller.id },
        caller.id
      )
    };
  }

  @Get('listings/mine')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Listings owned by the current user' })
  async myListings(@CurrentUser() actor: User | null) {
    const caller = requireActor(actor);
    return { data: await this.mechanization.listOwnerListings(caller.id) };
  }

  @Get('listings/:id')
  @ApiOperation({ summary: 'Listing detail (rates, operator badge, service area summary)' })
  async getListing(@Param('id') id: string) {
    return { data: await this.mechanization.getListing(id) };
  }

  @Post('listings/:id/status')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Drive the listing lifecycle DRAFT→ACTIVE→PAUSED (owner/admin)' })
  async setListingStatus(
    @Param('id') id: string,
    @Body() dto: SetListingStatusDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.mechanization.setListingStatus(id, dto.status, requireActor(actor)) };
  }

  @Post('listings/:id/operator-verification')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Set operator licence verification (admin only)' })
  async setOperatorVerification(
    @Param('id') id: string,
    @Body() dto: SetOperatorVerificationDto,
    @CurrentUser() actor: User | null
  ) {
    return {
      data: await this.mechanization.setOperatorVerification(
        id,
        dto.operatorVerification,
        actor?.id ?? 'anonymous'
      )
    };
  }

  @Post('listings/:id/bookings')
  @UseGuards(RolesGuard)
  @Roles('farmer', 'admin')
  @ApiOperation({ summary: 'Request a booking (farmer: plot, area, preferred window)' })
  async requestBooking(
    @Param('id') id: string,
    @Body() dto: CreateBookingDto,
    @CurrentUser() actor: User | null
  ) {
    const caller = requireActor(actor);
    return {
      data: await this.mechanization.requestBooking(id, { ...dto, farmerId: caller.id })
    };
  }

  // Declared before `bookings/:id` so literal routes are not captured as ids.
  @Get('bookings/mine')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'The current farmer\'s bookings, newest first' })
  async myBookings(@CurrentUser() actor: User | null) {
    const caller = requireActor(actor);
    return { data: await this.mechanization.listBookingsForFarmer(caller.id) };
  }

  @Get('bookings/queue')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Owner booking queue (optional status filter)' })
  async ownerQueue(@Query() query: ListOwnerBookingsQuery, @CurrentUser() actor: User | null) {
    const caller = requireActor(actor);
    return { data: await this.mechanization.listBookingsForOwner(caller.id, query.status) };
  }

  @Get('owner/stats')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Derived utilization stats for the current owner' })
  async ownerStats(@CurrentUser() actor: User | null) {
    const caller = requireActor(actor);
    return { data: await this.mechanization.utilizationStats(caller.id) };
  }

  @Get('bookings/:id')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Booking detail (parties and admin)' })
  async getBooking(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const caller = requireActor(actor);
    const booking = await this.mechanization.getBooking(id);
    if (
      booking.farmerId !== caller.id &&
      booking.ownerUserId !== caller.id &&
      !caller.roles.includes('admin')
    ) {
      throw new UnauthorizedException('Only a booking party may view this booking');
    }
    return { data: booking };
  }

  @Post('bookings/:id/quote')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Owner accepts a request — server-computed quote + advisory' })
  async quoteBooking(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.mechanization.quoteBooking(id, requireActor(actor)) };
  }

  @Post('bookings/:id/confirm')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Farmer accepts the quote — payment HOLD via the ledger (stub mode)' })
  async confirmBooking(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.mechanization.confirmBooking(id, requireActor(actor)) };
  }

  @Post('bookings/:id/start')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Owner marks the equipment deployed (confirmed → in_service)' })
  async startService(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.mechanization.startService(id, requireActor(actor)) };
  }

  @Post('bookings/:id/complete')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Party confirms completion — the second confirmation releases the hold' })
  async confirmCompletion(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.mechanization.confirmCompletion(id, requireActor(actor)) };
  }

  @Post('bookings/:id/cancel')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Cancel with the deterministic hold-release schedule' })
  async cancelBooking(
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.mechanization.cancelBooking(id, requireActor(actor), dto.reason) };
  }

  @Post('bookings/:id/dispute')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Freeze the hold pending admin resolution' })
  async disputeBooking(
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.mechanization.disputeBooking(id, requireActor(actor), dto.reason) };
  }

  @Post('bookings/:id/resolve')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Admin dispute resolution — the frozen hold pays out 100% one way' })
  async resolveDispute(
    @Param('id') id: string,
    @Body() dto: ResolveDisputeDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.mechanization.resolveDispute(id, dto.outcome, requireActor(actor)) };
  }

  @Post('bookings/:id/rate')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Farmer rates a completed booking (1–5)' })
  async rateBooking(
    @Param('id') id: string,
    @Body() dto: RateBookingDto,
    @CurrentUser() actor: User | null
  ) {
    return {
      data: await this.mechanization.rateBooking(id, requireActor(actor), dto.rating, dto.comment)
    };
  }

  @Post('bookings/auto-complete')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Sweep: auto-complete in-service bookings past window end + grace' })
  async autoComplete(@CurrentUser() actor: User | null) {
    requireActor(actor);
    return { data: await this.mechanization.autoCompleteExpired() };
  }
}
