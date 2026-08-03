import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsISO8601,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min
} from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { TraceabilityService } from './traceability.service.js';
import type {
  AddCustodyEventInput,
  AggregateLotsInput,
  CreateLotInput,
  SplitLotInput
} from './traceability.service.js';
import { CUSTODY_EVENT_TYPES } from './traceability.types.js';

class CreateLotDto implements CreateLotInput {
  @IsString()
  crop!: string;

  @IsOptional()
  @IsString()
  variety?: string;

  @IsISO8601()
  harvestWindowStart!: string;

  @IsISO8601()
  harvestWindowEnd!: string;

  @IsNumber()
  @Min(0)
  quantity!: number;

  @IsString()
  unit!: string;
}

class AddCustodyEventDto implements AddCustodyEventInput {
  @IsIn([...CUSTODY_EVENT_TYPES])
  type!: AddCustodyEventInput['type'];

  @IsISO8601()
  occurredAt!: string;

  @IsNumber()
  latitude!: number;

  @IsNumber()
  longitude!: number;

  @IsOptional()
  @IsString()
  h3Cell?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

class LinkPlotDto {
  @IsString()
  plotId!: string;
}

class SplitLotDto implements SplitLotInput {
  @IsNumber()
  @Min(0)
  quantity!: number;

  @IsISO8601()
  occurredAt!: string;

  @IsNumber()
  latitude!: number;

  @IsNumber()
  longitude!: number;

  @IsOptional()
  @IsString()
  h3Cell?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

class AggregateLotsDto implements AggregateLotsInput {
  @IsArray()
  @IsString({ each: true })
  parentLotIds!: string[];

  @IsString()
  crop!: string;

  @IsNumber()
  @Min(0)
  quantity!: number;

  @IsString()
  unit!: string;

  @IsISO8601()
  occurredAt!: string;

  @IsNumber()
  latitude!: number;

  @IsNumber()
  longitude!: number;

  @IsOptional()
  @IsString()
  h3Cell?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

class CreateShipmentDto {
  @IsArray()
  @IsString({ each: true })
  lotIds!: string[];

  @IsOptional()
  @IsString()
  reference?: string;
}

class ListLotsQuery {
  @IsOptional()
  @IsString()
  ownerUserId?: string;
}

/**
 * Internal traceability surface (wave-eudr): lot CRUD, custody timeline,
 * split/aggregate genealogy, shipment builder and the DDS export + verify
 * endpoints. All routes require an authenticated platform identity;
 * ownership rules live in the service (assertSelfOrAdmin-style defence in
 * depth: the guard authenticates, the service authorises per record).
 */
@ApiTags('traceability')
@Controller('traceability')
@UseGuards(RolesGuard)
export class TraceabilityController {
  constructor(private readonly traceability: TraceabilityService) {}

  @Post('lots')
  @Authenticated()
  @ApiOperation({ summary: 'Create a commodity lot (owner = caller).' })
  async createLot(@Body() dto: CreateLotDto, @CurrentUser() actor: User | null) {
    return { data: await this.traceability.createLot(actor, dto) };
  }

  @Get('lots')
  @Authenticated()
  @ApiOperation({
    summary: 'List lots. Non-admins only ever see their own; admins may filter by ownerUserId.'
  })
  async listLots(@Query() query: ListLotsQuery, @CurrentUser() actor: User | null) {
    return { data: await this.traceability.listLots(actor, query.ownerUserId) };
  }

  @Post('lots/aggregate')
  @Authenticated()
  @ApiOperation({
    summary: 'Aggregate two or more lots into a new child lot (genealogy preserved).'
  })
  async aggregateLots(@Body() dto: AggregateLotsDto, @CurrentUser() actor: User | null) {
    return { data: await this.traceability.aggregateLots(actor, dto) };
  }

  @Get('lots/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Fetch a lot (owner, custody-holding aggregator or admin).' })
  async getLot(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.traceability.getLot(actor, id) };
  }

  @Post('lots/:id/events')
  @Authenticated()
  @ApiOperation({
    summary: 'Append a custody event to the lot hash chain. actorId is always the caller.'
  })
  async addEvent(
    @Param('id') id: string,
    @Body() dto: AddCustodyEventDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.traceability.addCustodyEvent(actor, id, dto) };
  }

  @Get('lots/:id/timeline')
  @Authenticated()
  @ApiOperation({
    summary: 'Custody timeline with recomputed hash-chain verification for the lot.'
  })
  async timeline(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.traceability.timeline(actor, id) };
  }

  @Post('lots/:id/split')
  @Authenticated()
  @ApiOperation({ summary: 'Split a child lot off this lot (parent ref preserved).' })
  async splitLot(
    @Param('id') id: string,
    @Body() dto: SplitLotDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.traceability.splitLot(actor, id, dto) };
  }

  @Post('lots/:id/plots')
  @Authenticated()
  @ApiOperation({
    summary: 'Attach a production plot: copies its geometry into an immutable evidence snapshot.'
  })
  async linkPlot(
    @Param('id') id: string,
    @Body() dto: LinkPlotDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.traceability.linkPlot(actor, id, dto) };
  }

  @Get('lots/:id/plots')
  @Authenticated()
  @ApiOperation({ summary: 'List the immutable plot-geometry snapshots linked to a lot.' })
  async listPlotLinks(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.traceability.listPlotLinks(actor, id) };
  }

  @Post('shipments')
  @Authenticated()
  @ApiOperation({ summary: 'Build a shipment from readable lots (composition fixed at creation).' })
  async createShipment(@Body() dto: CreateShipmentDto, @CurrentUser() actor: User | null) {
    return { data: await this.traceability.createShipment(actor, dto) };
  }

  @Get('shipments')
  @Authenticated()
  @ApiOperation({ summary: 'List shipments created by the caller (admins see all).' })
  async listShipments(@CurrentUser() actor: User | null) {
    return { data: await this.traceability.listShipments(actor) };
  }

  @Get('shipments/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Fetch a shipment with its lots.' })
  async getShipment(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.traceability.getShipment(actor, id) };
  }

  @Get('shipments/:id/dds')
  @Authenticated()
  @ApiOperation({
    summary:
      'Export the EUDR-aligned due-diligence statement JSON (operator placeholder + honest risk basis + chain integrity proof).'
  })
  async exportDds(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.traceability.exportDds(actor, id) };
  }

  @Get('shipments/:id/dds/verify')
  @Authenticated()
  @ApiOperation({
    summary: 'Recompute the hash chain for every lot in the shipment; per-event validity.'
  })
  async verifyDds(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.traceability.verifyShipmentChain(actor, id) };
  }
}
