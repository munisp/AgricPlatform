import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Min
} from 'class-validator';
import type { User } from '@agric-platform/shared';
import {
  FARM_EXPENSE_CATEGORIES,
  HARVEST_QUALITY_GRADES,
  HARVEST_UNITS,
  PLANTING_STATUSES,
  SOIL_TYPES
} from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import type {
  CreateExpenseInput,
  CreatePlantingInput,
  CreatePlotInput,
  RecordHarvestInput,
  UpdatePlotInput
} from './farms.service.js';
import { FarmsService } from './farms.service.js';

class CreatePlotDto implements CreatePlotInput {
  @IsString()
  name!: string;

  @IsString()
  state!: string;

  @IsString()
  lga!: string;

  @IsNumber()
  centroidLat!: number;

  @IsNumber()
  centroidLong!: number;

  /** Raw GeoJSON Polygon/MultiPolygon geometry; structurally validated. */
  @IsOptional()
  boundaryGeojson?: unknown;

  @IsNumber()
  sizeHectares!: number;

  @IsOptional()
  @IsIn([...SOIL_TYPES])
  soilType?: CreatePlotInput['soilType'];

  @IsOptional()
  @IsString()
  clientId?: string;
}

class UpdatePlotDto implements UpdatePlotInput {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  lga?: string;

  @IsOptional()
  @IsNumber()
  centroidLat?: number;

  @IsOptional()
  @IsNumber()
  centroidLong?: number;

  @IsOptional()
  boundaryGeojson?: unknown;

  @IsOptional()
  @IsNumber()
  sizeHectares?: number;

  @IsOptional()
  @IsIn([...SOIL_TYPES])
  soilType?: UpdatePlotInput['soilType'];
}

class ListPlotsQuery {
  @IsOptional()
  @IsString()
  ownerUserId?: string;

  @IsOptional()
  @IsString()
  state?: string;
}

class CreatePlantingDto implements CreatePlantingInput {
  @IsString()
  crop!: string;

  @IsOptional()
  @IsString()
  variety?: string;

  @IsString()
  season!: string;

  @IsISO8601()
  plantedAt!: string;

  @IsOptional()
  @IsISO8601()
  expectedHarvestAt?: string;

  @IsOptional()
  @IsString()
  clientId?: string;
}

class UpdatePlantingStatusDto {
  @IsIn([...PLANTING_STATUSES])
  status!: (typeof PLANTING_STATUSES)[number];
}

class RecordHarvestDto implements RecordHarvestInput {
  @IsISO8601()
  harvestedAt!: string;

  @IsNumber()
  @Min(0)
  quantity!: number;

  @IsIn([...HARVEST_UNITS])
  unit!: RecordHarvestInput['unit'];

  @IsOptional()
  @IsIn([...HARVEST_QUALITY_GRADES])
  qualityGrade?: RecordHarvestInput['qualityGrade'];
}

class CreateExpenseDto implements CreateExpenseInput {
  @IsIn([...FARM_EXPENSE_CATEGORIES])
  category!: CreateExpenseInput['category'];

  /** Minor units (kobo); integer, never a float. */
  @IsInt()
  @Min(0)
  amountKobo!: number;

  @IsISO8601()
  incurredAt!: string;

  @IsOptional()
  @IsString()
  note?: string;
}

class SummaryQuery {
  @IsOptional()
  @IsString()
  ownerUserId?: string;
}

@ApiTags('farms')
@Controller('farms')
@UseGuards(RolesGuard)
export class FarmsController {
  constructor(private readonly farms: FarmsService) {}

  /* ------------------------------ summary ------------------------------ */

  @Get('summary')
  @Authenticated()
  @ApiOperation({
    summary:
      'Per-owner aggregates (plot count, active plantings, harvest totals by crop). Non-admins always see their own.'
  })
  async summary(@Query() query: SummaryQuery, @CurrentUser() actor: User | null) {
    return { data: await this.farms.summary(actor, query.ownerUserId) };
  }

  /* ------------------------------- plots ------------------------------- */

  @Post('plots')
  @Authenticated()
  @ApiOperation({
    summary: 'Register a farm plot (owner = caller). Idempotency-Key supported.'
  })
  async createPlot(@Body() dto: CreatePlotDto, @CurrentUser() actor: User | null) {
    return { data: await this.farms.createPlot(actor, dto) };
  }

  @Get('plots')
  @Authenticated()
  @ApiOperation({
    summary:
      "List plots. Owner-scoped: non-admins only ever see their own; admins may filter by ownerUserId or see all."
  })
  async listPlots(@Query() query: ListPlotsQuery, @CurrentUser() actor: User | null) {
    return {
      data: await this.farms.listPlots(actor, {
        ownerUserId: query.ownerUserId,
        state: query.state
      })
    };
  }

  @Get('plots/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Plot detail (owner or admin)' })
  async getPlot(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.farms.getPlot(actor, id) };
  }

  @Patch('plots/:id')
  @Authenticated()
  @ApiOperation({
    summary: 'Update plot fields (owner or admin). Bumps the offline-sync version.'
  })
  async updatePlot(
    @Param('id') id: string,
    @Body() dto: UpdatePlotDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.farms.updatePlot(actor, id, dto) };
  }

  @Delete('plots/:id')
  @Authenticated()
  @ApiOperation({
    summary: 'Remove a plot and its plantings/harvests/expenses (owner or admin).'
  })
  async removePlot(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.farms.removePlot(actor, id) };
  }

  /* ----------------------------- plantings ----------------------------- */

  @Post('plots/:plotId/plantings')
  @Authenticated()
  @ApiOperation({
    summary: 'Record a crop planting on a plot (owner or admin). Idempotency-Key supported.'
  })
  async createPlanting(
    @Param('plotId') plotId: string,
    @Body() dto: CreatePlantingDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.farms.createPlanting(actor, plotId, dto) };
  }

  @Get('plots/:plotId/plantings')
  @Authenticated()
  @ApiOperation({ summary: 'List plantings on a plot (owner or admin)' })
  async listPlantings(@Param('plotId') plotId: string, @CurrentUser() actor: User | null) {
    return { data: await this.farms.listPlantings(actor, plotId) };
  }

  @Patch('plantings/:id')
  @Authenticated()
  @ApiOperation({
    summary:
      "Transition a planting's status (growing → harvested | failed; both terminal). Owner or admin."
  })
  async updatePlantingStatus(
    @Param('id') id: string,
    @Body() dto: UpdatePlantingStatusDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.farms.updatePlantingStatus(actor, id, dto.status) };
  }

  /* ------------------------------ harvests ----------------------------- */

  @Post('plantings/:plantingId/harvests')
  @Authenticated()
  @ApiOperation({
    summary:
      'Record a harvest against a planting; flips a growing planting to harvested. Idempotency-Key supported.'
  })
  async recordHarvest(
    @Param('plantingId') plantingId: string,
    @Body() dto: RecordHarvestDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.farms.recordHarvest(actor, plantingId, dto) };
  }

  @Get('plantings/:plantingId/harvests')
  @Authenticated()
  @ApiOperation({ summary: 'List harvest records for a planting (owner or admin)' })
  async listHarvests(@Param('plantingId') plantingId: string, @CurrentUser() actor: User | null) {
    return { data: await this.farms.listHarvests(actor, plantingId) };
  }

  /* ------------------------------ expenses ----------------------------- */

  @Post('plots/:plotId/expenses')
  @Authenticated()
  @ApiOperation({
    summary: 'Record a plot expense in kobo (owner or admin). Idempotency-Key supported.'
  })
  async createExpense(
    @Param('plotId') plotId: string,
    @Body() dto: CreateExpenseDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.farms.createExpense(actor, plotId, dto) };
  }

  @Get('plots/:plotId/expenses')
  @Authenticated()
  @ApiOperation({ summary: 'List expenses for a plot (owner or admin)' })
  async listExpenses(@Param('plotId') plotId: string, @CurrentUser() actor: User | null) {
    return { data: await this.farms.listExpenses(actor, plotId) };
  }
}
