import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import {
  FRAUD_ALERT_STATUSES,
  FRAUD_CASE_STATUSES,
  type FraudAlertStatus,
  type FraudCaseStatus
} from '../../database/repositories/fraud.repository.js';
import { FLOAT_SENTINEL_FLAG, FraudSentinelService } from './sentinel.service.js';

class AlertQuery {
  @IsOptional()
  @IsIn(FRAUD_ALERT_STATUSES)
  status?: FraudAlertStatus;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ruleCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  subjectId?: string;
}

class ResolveAlertDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  resolution?: string;
}

class DismissAlertDto {
  @IsString()
  @MaxLength(2000)
  reason!: string;
}

class UpdateRuleParamsDto {
  @IsObject()
  params!: Record<string, unknown>;
}

class ToggleRuleDto {
  @IsBoolean()
  enabled!: boolean;
}

class CreateCaseDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayNotEmpty()
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  alertIds!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  assignee?: string;
}

class CaseQuery {
  @IsOptional()
  @IsIn(FRAUD_CASE_STATUSES)
  status?: FraudCaseStatus;
}

class ResolveCaseDto {
  @IsString()
  @MaxLength(500)
  resolution!: string;
}

/**
 * Float Sentinel admin surface (Stage 27) — the fraud/liquidity case queue.
 *
 * The sentinel is a DETECTIVE control: it never blocks money movement. This
 * controller exposes only the observe-then-act surface — alert triage
 * (confirm/dismiss), case grouping/resolution, and versioned rule tuning.
 *
 * Auth: admin role (spec called for a `risk_officer` role, which does not
 * exist in USER_ROLES — admin is the platform's existing risk/ops role; see
 * HANDOFF.md). The whole surface is flag-gated behind `float-sentinel`
 * (fail-closed 404 when off) and every mutation is audit-chained.
 *
 * POST sentinel/run is the scheduler entry point (same convention as the
 * analytics projector's POST /api/v1/analytics/project) — an external
 * cron/systemd/k8s CronJob drives evaluation passes.
 */
@ApiTags('admin')
@Controller('admin/fraud')
@UseGuards(RolesGuard, FeatureFlagGuard)
@Roles('admin')
@RequiresFeature(FLOAT_SENTINEL_FLAG)
export class FraudCasesController {
  constructor(private readonly sentinel: FraudSentinelService) {}

  @Get('alerts')
  @ApiOperation({ summary: 'List fraud/liquidity alerts (filter by status/rule/subject)' })
  async alerts(@Query() query: AlertQuery) {
    return {
      data: await this.sentinel.listAlerts({
        ...(query.status ? { status: query.status } : {}),
        ...(query.ruleCode ? { ruleCode: query.ruleCode } : {}),
        ...(query.subjectId ? { subjectId: query.subjectId } : {})
      })
    };
  }

  @Post('alerts/:id/confirm')
  @ApiOperation({ summary: 'Confirm an open alert (guarded CAS; audited)' })
  async confirmAlert(
    @Param('id') id: string,
    @Body() dto: ResolveAlertDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.sentinel.confirmAlert(id, actor?.id ?? 'admin', dto.resolution) };
  }

  @Post('alerts/:id/dismiss')
  @ApiOperation({ summary: 'Dismiss an open alert with a reason (guarded CAS; audited)' })
  async dismissAlert(
    @Param('id') id: string,
    @Body() dto: DismissAlertDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.sentinel.dismissAlert(id, actor?.id ?? 'admin', dto.reason) };
  }

  @Get('rules')
  @ApiOperation({ summary: 'List current-version sentinel rules with per-rule hit counts' })
  async rules() {
    return { data: await this.sentinel.listRules() };
  }

  @Post('rules/:code/params')
  @ApiOperation({
    summary:
      'Tune a rule: creates the next IMMUTABLE version with merged params (audit-chained; old versions untouched)'
  })
  async updateRuleParams(
    @Param('code') code: string,
    @Body() dto: UpdateRuleParamsDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.sentinel.updateRuleParams(code, dto.params, actor?.id ?? 'admin') };
  }

  @Post('rules/:code/toggle')
  @ApiOperation({ summary: 'Enable/disable an individual rule (audited)' })
  async toggleRule(
    @Param('code') code: string,
    @Body() dto: ToggleRuleDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.sentinel.setRuleEnabled(code, dto.enabled, actor?.id ?? 'admin') };
  }

  @Post('cases')
  @ApiOperation({ summary: 'Group alerts into an officer case (audited)' })
  async createCase(@Body() dto: CreateCaseDto, @CurrentUser() actor: User | null) {
    return { data: await this.sentinel.createCase(dto.alertIds, dto.assignee, actor?.id ?? 'admin') };
  }

  @Get('cases')
  @ApiOperation({ summary: 'List fraud cases (filter by status)' })
  async cases(@Query() query: CaseQuery) {
    return {
      data: await this.sentinel.listCases({
        ...(query.status ? { status: query.status } : {})
      })
    };
  }

  @Post('cases/:id/resolve')
  @ApiOperation({ summary: 'Resolve an open case (guarded CAS; audited; publishes fraud.case.resolved)' })
  async resolveCase(
    @Param('id') id: string,
    @Body() dto: ResolveCaseDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.sentinel.resolveCase(id, dto.resolution, actor?.id ?? 'admin') };
  }

  @Post('sentinel/run')
  @ApiOperation({
    summary:
      'Run one sentinel evaluation pass over the outbox (external scheduler entry point; idempotent)'
  })
  async run() {
    return { data: await this.sentinel.run() };
  }
}
