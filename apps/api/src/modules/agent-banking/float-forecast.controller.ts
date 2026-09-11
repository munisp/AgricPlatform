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
import { ArrayNotEmpty, IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import {
  REBALANCE_ALERT_STATUSES,
  REBALANCE_RUN_STATUSES,
  type RebalanceAlertStatus,
  type RebalanceRunStatus
} from '../../database/repositories/float-forecast.repository.js';
import { MAX_FORECAST_HORIZON_DAYS } from './float-forecast.js';
import { FLOAT_FORECASTER_FLAG, FloatForecastService } from './float-forecast.service.js';

class ForecastQuery {
  @IsOptional()
  @IsString()
  agentId?: string;
}

class AlertQueryDto {
  @IsOptional()
  @IsIn(REBALANCE_ALERT_STATUSES)
  status?: RebalanceAlertStatus;

  @IsOptional()
  @IsString()
  agentId?: string;
}

class ResolveAlertDto {
  @IsOptional()
  @IsString()
  resolution?: string;
}

class CreateRunDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  alertIds!: string[];

  @IsOptional()
  @IsString()
  notes?: string;
}

class RunQueryDto {
  @IsOptional()
  @IsIn(REBALANCE_RUN_STATUSES)
  status?: RebalanceRunStatus;
}

class ForecastRunDto {
  /** Pin the as-of day (YYYY-MM-DD); defaults to today (UTC). */
  @IsOptional()
  @IsString()
  asOfDate?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_FORECAST_HORIZON_DAYS)
  horizonDays?: number;
}

function actorIdOf(user: User | null): string {
  if (!user) {
    throw new UnauthorizedException('Authentication required');
  }
  return user.id;
}

/**
 * Float Forecaster surface (Stage 27, Innovation 15) — agent liquidity
 * prediction and the rebalancing alert queue for network ops.
 *
 * The forecaster is strictly READ-ONLY on the ledger and never moves money:
 * it predicts, alerts, and a human dispatches. Auth: admin role (the spec's
 * "ops role" — USER_ROLES has no dedicated ops/network-operator role; admin
 * is the platform's existing operations role, same mapping the Float
 * Sentinel surface used). The whole surface is flag-gated behind
 * `float-forecaster` (fail-closed 404 when off).
 *
 * POST forecast/run is the nightly scheduler entry point (same convention
 * as the analytics projector's POST /api/v1/analytics/project): no
 * in-process timer exists — an external cron/k8s CronJob drives the pass.
 */
@ApiTags('agent-banking')
@Controller('agent-banking')
@UseGuards(RolesGuard, FeatureFlagGuard)
@Roles('admin')
@RequiresFeature(FLOAT_FORECASTER_FLAG)
export class FloatForecastController {
  constructor(private readonly forecaster: FloatForecastService) {}

  @Get('forecasts')
  @ApiOperation({ summary: 'Per-agent float forecasts (latest runs; ops/admin)' })
  async forecasts(@Query() query: ForecastQuery) {
    return {
      data: await this.forecaster.listForecasts({
        ...(query.agentId ? { agentId: query.agentId } : {})
      })
    };
  }

  @Get('rebalance-alerts')
  @ApiOperation({ summary: 'Rebalance alert queue, e.g. ?status=open (ops/admin)' })
  async alerts(@Query() query: AlertQueryDto) {
    return {
      data: await this.forecaster.listAlerts({
        ...(query.status ? { status: query.status } : {}),
        ...(query.agentId ? { agentId: query.agentId } : {})
      })
    };
  }

  @Post('rebalance-alerts/:id/ack')
  @ApiOperation({ summary: 'Acknowledge an open alert (guarded CAS open→acknowledged; 409 on race)' })
  async ack(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.forecaster.acknowledgeAlert(id, actorIdOf(actor)) };
  }

  @Post('rebalance-alerts/:id/resolve')
  @ApiOperation({ summary: 'Resolve an open/acknowledged alert (guarded CAS; audited via outbox)' })
  async resolve(@Param('id') id: string, @Body() dto: ResolveAlertDto, @CurrentUser() actor: User | null) {
    return { data: await this.forecaster.resolveAlert(id, actorIdOf(actor), dto.resolution) };
  }

  @Post('rebalance-runs')
  @ApiOperation({
    summary: 'Group unclaimed open alerts into one ops route batch (guarded claims; one run per alert)'
  })
  async createRun(@Body() dto: CreateRunDto, @CurrentUser() actor: User | null) {
    return { data: await this.forecaster.createRun(dto.alertIds, actorIdOf(actor), dto.notes) };
  }

  @Get('rebalance-runs')
  @ApiOperation({ summary: 'List rebalance runs (ops/admin)' })
  async runs(@Query() query: RunQueryDto) {
    return {
      data: await this.forecaster.listRuns({
        ...(query.status ? { status: query.status } : {})
      })
    };
  }

  @Post('forecast/run')
  @ApiOperation({
    summary:
      'Run one nightly forecasting pass over all ACTIVE agents (external scheduler entry point; ' +
      'rerun-idempotent per as-of date; alerts dedupe to one open row per agent per type)'
  })
  async run(@Body() dto: ForecastRunDto, @CurrentUser() actor: User | null) {
    return {
      data: await this.forecaster.run(
        {
          ...(dto.asOfDate ? { asOfDate: dto.asOfDate } : {}),
          ...(dto.horizonDays !== undefined ? { horizonDays: dto.horizonDays } : {})
        },
        actor?.id ?? 'scheduler'
      )
    };
  }
}
