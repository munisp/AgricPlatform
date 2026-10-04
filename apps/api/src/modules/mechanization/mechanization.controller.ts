import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsISO8601, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Public } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import {
  MechanizationService,
  type CreateEquipmentInput,
  type CreateOperatorInput,
  type CreateRequestInput
} from './mechanization.service.js';

const EQUIPMENT_TYPES = [
  'tractor',
  'planter',
  'sprayer',
  'harvester',
  'thresher',
  'trailer',
  'other'
] as const;
const REQUEST_STATUSES = ['requested', 'quoted', 'accepted', 'scheduled', 'in_progress', 'completed', 'cancelled'] as const;

class ListEquipmentQuery extends ListQueryDto {
  @IsOptional()
  @IsIn(EQUIPMENT_TYPES)
  type?: (typeof EQUIPMENT_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  available?: boolean;
}

class CreateEquipmentDto implements CreateEquipmentInput {
  @IsIn(EQUIPMENT_TYPES)
  type!: (typeof EQUIPMENT_TYPES)[number];

  @IsString()
  @MaxLength(200)
  make!: string;

  @IsString()
  @MaxLength(200)
  model!: string;

  @IsInt()
  @Min(1900)
  @Max(2100)
  year!: number;

  @IsInt()
  @Min(0)
  hourlyRateNaira!: number;

  @IsInt()
  @Min(0)
  dailyRateNaira!: number;

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

class AvailabilityDto {
  @IsBoolean()
  available!: boolean;
}

class CreateOperatorDto implements CreateOperatorInput {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(100)
  phone!: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  lgas!: string[];

  @IsArray()
  @ArrayMaxSize(50)
  @IsIn(EQUIPMENT_TYPES, { each: true })
  equipmentTypes!: (typeof EQUIPMENT_TYPES)[number][];

  @IsInt()
  @Min(0)
  dailyRateNaira!: number;
}

class CreateRequestDto implements CreateRequestInput {
  @IsString()
  @MaxLength(100)
  farmerId!: string;

  @IsIn(EQUIPMENT_TYPES)
  equipmentType!: (typeof EQUIPMENT_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  equipmentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  operatorId?: string;

  @IsString()
  @MaxLength(100)
  lga!: string;

  @IsNumber()
  @Min(0.1)
  hectares!: number;

  @IsISO8601()
  preferredDate!: string;
}

class RequestStatusDto {
  @IsIn(REQUEST_STATUSES)
  status!: (typeof REQUEST_STATUSES)[number];
}

class QuoteDto {
  @IsInt()
  @Min(0)
  quoteNaira!: number;
}

/**
 * Mechanisation marketplace (tractors, sprayers, operators). Equipment and
 * operators are a public catalogue; requests are personal records visible
 * to the requesting farmer, the equipment owner, the operator or an admin,
 * with the state machine enforced in the service.
 */
@ApiTags('mechanization')
@Controller('mechanization')
@UseGuards(RolesGuard)
export class MechanizationController {
  constructor(private readonly mechanization: MechanizationService) {}

  @Get('equipment')
  @Public()
  @ApiOperation({ summary: 'Browse equipment listings (public catalogue)' })
  listEquipment(@Query() query: ListEquipmentQuery) {
    return this.mechanization.listEquipment(query);
  }

  @Post('equipment')
  @Authenticated()
  @ApiOperation({ summary: 'List equipment for hire (owner is the authenticated user)' })
  async createEquipment(@Body() dto: CreateEquipmentDto, @CurrentUser() actor: User | null) {
    return { data: await this.mechanization.createEquipment(dto, actor!.id) };
  }

  @Get('equipment/:id')
  @Public()
  @ApiOperation({ summary: 'Equipment detail (public catalogue)' })
  async getEquipment(@Param('id') id: string) {
    return { data: await this.mechanization.getEquipment(id) };
  }

  @Post('equipment/:id/availability')
  @Authenticated()
  @ApiOperation({ summary: 'Toggle equipment availability (owner or admin)' })
  async setAvailability(@Param('id') id: string, @Body() dto: AvailabilityDto, @CurrentUser() actor: User | null) {
    return { data: await this.mechanization.setAvailability(id, dto.available, actor!) };
  }

  @Get('operators')
  @Public()
  @ApiOperation({ summary: 'Browse equipment operators (public directory)' })
  async listOperators(@Query('lga') lga?: string) {
    return { data: await this.mechanization.listOperators(lga) };
  }

  @Post('operators')
  @Authenticated()
  @ApiOperation({ summary: 'Register as an equipment operator' })
  async createOperator(@Body() dto: CreateOperatorDto, @CurrentUser() actor: User | null) {
    return { data: await this.mechanization.createOperator(dto, actor!.id) };
  }

  @Get('requests')
  @Authenticated()
  @ApiOperation({ summary: 'List service requests (own, operator, equipment owner or admin)' })
  async listRequests(
    @CurrentUser() actor: User | null,
    @Query('farmerId') farmerId?: string,
    @Query('ownerId') ownerId?: string,
    @Query('operatorId') operatorId?: string,
    @Query('status') status?: (typeof REQUEST_STATUSES)[number]
  ) {
    if (farmerId) assertSelfOrAdmin(actor, farmerId);
    if (ownerId) assertSelfOrAdmin(actor, ownerId);
    if (operatorId) assertSelfOrAdmin(actor, operatorId);
    if (!farmerId && !ownerId && !operatorId && !actor?.roles.includes('admin')) {
      throw new ForbiddenException('Listing requests across users requires the admin role');
    }
    return { data: await this.mechanization.listRequests({ farmerId, ownerId, operatorId, status }) };
  }

  @Post('requests')
  @Authenticated()
  @ApiOperation({ summary: 'Request equipment/operator hire (own request or admin)' })
  async createRequest(@Body() dto: CreateRequestDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.farmerId);
    return { data: await this.mechanization.createRequest(dto, actor!) };
  }

  @Get('requests/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Request detail (farmer, owner, operator or admin)' })
  async getRequest(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const request = await this.mechanization.getRequest(id);
    this.mechanization.assertRequestVisible(request, actor);
    return { data: request };
  }

  @Post('requests/:id/status')
  @Authenticated()
  @ApiOperation({ summary: 'Advance a request status (actor-checked state machine in the service)' })
  async setStatus(@Param('id') id: string, @Body() dto: RequestStatusDto, @CurrentUser() actor: User | null) {
    return { data: await this.mechanization.transitionRequest(id, dto.status, actor!) };
  }

  @Post('requests/:id/quote')
  @Authenticated()
  @ApiOperation({ summary: 'Quote a price for a request (equipment owner, operator or admin)' })
  async quote(@Param('id') id: string, @Body() dto: QuoteDto, @CurrentUser() actor: User | null) {
    return { data: await this.mechanization.quoteRequest(id, dto.quoteNaira, actor!) };
  }
}
