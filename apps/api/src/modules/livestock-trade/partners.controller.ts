import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsISO8601,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min
} from 'class-validator';
import type { User } from '@agric-platform/shared';
import { NIGERIAN_STATES } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import type { CreateAggregationPointInput } from './aggregation-points.service.js';
import { AggregationPointsService } from './aggregation-points.service.js';
import type { IngestReadingInput } from './cold-chain.service.js';
import { ColdChainService } from './cold-chain.service.js';

class CreateAggregationPointDto implements CreateAggregationPointInput {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsIn([...NIGERIAN_STATES])
  state!: string;

  @IsString()
  @IsNotEmpty()
  lga!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;
}

class ListPointsQuery {
  @IsOptional()
  @IsString()
  state?: string;
}

class IngestReadingDto implements IngestReadingInput {
  @IsISO8601()
  recordedAt!: string;

  @IsNumber()
  temperatureCelsius!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  humidityPercent?: number;
}

@ApiTags('livestock-partners')
@Controller('livestock-partners')
@UseGuards(RolesGuard)
export class LivestockPartnersController {
  constructor(
    private readonly points: AggregationPointsService,
    private readonly coldChain: ColdChainService
  ) {}

  // -- Aggregation points (F7) ---------------------------------------------------

  @Post('aggregation-points')
  @Authenticated()
  @ApiOperation({ summary: 'Register an aggregation point (partner manager or admin)' })
  async createPoint(@Body() dto: CreateAggregationPointDto, @CurrentUser() actor: User | null) {
    return { data: await this.points.create(actor, dto) };
  }

  @Get('aggregation-points')
  @Authenticated()
  @ApiOperation({ summary: 'List active aggregation points (filter by state)' })
  async listPoints(@Query() query: ListPointsQuery, @CurrentUser() actor: User | null) {
    return { data: await this.points.list(actor, query.state) };
  }

  @Get('aggregation-points/mine')
  @Authenticated()
  @ApiOperation({ summary: 'Points managed by the caller' })
  async listMyPoints(@CurrentUser() actor: User | null) {
    return { data: await this.points.listMine(actor) };
  }

  @Get('aggregation-points/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Aggregation point detail including assigned lots' })
  async getPoint(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.points.getById(actor, id) };
  }

  @Post('aggregation-points/:id/lots/:lotId')
  @Authenticated()
  @ApiOperation({
    summary:
      'Assign a lot to a point (manager or admin). Enforces single-species consistency and capacity; publishes a logistics event.'
  })
  async assignLot(
    @Param('id') id: string,
    @Param('lotId') lotId: string,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.points.assignLot(actor, id, lotId) };
  }

  @Delete('aggregation-points/:id/lots/:lotId')
  @Authenticated()
  @ApiOperation({ summary: 'Remove a lot from a point (manager or admin)' })
  async unassignLot(
    @Param('id') id: string,
    @Param('lotId') lotId: string,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.points.unassignLot(actor, id, lotId) };
  }

  @Post('aggregation-points/:id/deactivate')
  @Authenticated()
  @ApiOperation({ summary: 'Deactivate a point (manager or admin)' })
  async deactivatePoint(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.points.deactivate(actor, id) };
  }

  // -- Cold-chain telemetry --------------------------------------------------------

  @Post('aggregation-points/:id/cold-chain')
  @Authenticated()
  @ApiOperation({
    summary:
      'Ingest a temperature reading via the cold-chain provider (manager or admin). Fails closed while no provider is configured.'
  })
  async ingestReading(
    @Param('id') id: string,
    @Body() dto: IngestReadingDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.coldChain.ingest(actor, id, dto) };
  }

  @Get('aggregation-points/:id/cold-chain')
  @Authenticated()
  @ApiOperation({ summary: 'Temperature log for a point (manager or admin)' })
  async listReadings(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.coldChain.listLogs(actor, id) };
  }
}
