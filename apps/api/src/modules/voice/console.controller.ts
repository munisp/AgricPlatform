import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import {
  ESCALATION_CASE_STATUSES,
  type EscalationCaseStatus
} from '../../database/repositories/escalation-console.repository.js';
import { EscalationConsoleService, MAX_ANSWER_TEXT_LENGTH } from './escalation-console.service.js';

/**
 * V-71/V-74: DTO classes (not inline literals) so the global ValidationPipe
 * actually validates these bodies; answerText is capped because it is
 * dispatched over a paid SMS channel.
 */
class AnswerCaseDto {
  @IsString()
  @MaxLength(MAX_ANSWER_TEXT_LENGTH)
  answerText!: string;
}

class ScoreQualityDto {
  @IsInt()
  @Min(1)
  @Max(5)
  score!: number;

  @IsOptional()
  @IsBoolean()
  close?: boolean;
}

/**
 * Agronomist SLA console (Stage 27 innovation #19) — the operated queue
 * behind the voice agronomist's human-escalation promise. Entire surface is
 * gated by the `agronomist-console` feature flag (default OFF; fail-closed
 * 404 while disabled).
 */
@ApiTags('agronomist-console')
@UseGuards(RolesGuard)
@RequiresFeature('agronomist-console')
@Controller('agronomist')
export class AgronomistConsoleController {
  constructor(private readonly console: EscalationConsoleService) {}

  @Get('cases')
  @Roles('agronomist', 'supervisor', 'admin')
  @ApiOperation({
    summary: 'Escalation case queue (agronomist/supervisor). Ordered by SLA deadline.'
  })
  async listCases(
    @CurrentUser() actor: User | null,
    @Query('status') status?: string,
    @Query('cohort') cohort?: string
  ) {
    const parsed = ESCALATION_CASE_STATUSES.includes(status as EscalationCaseStatus)
      ? (status as EscalationCaseStatus)
      : undefined;
    return {
      data: await this.console.listCases(actor, {
        ...(parsed ? { status: parsed } : {}),
        ...(cohort ? { cohort } : {})
      })
    };
  }

  @Get('cases/:id')
  @Roles('agronomist', 'supervisor', 'admin')
  @ApiOperation({ summary: 'Escalation case detail with honest delivery status.' })
  async getCase(@CurrentUser() actor: User | null, @Param('id') id: string) {
    return { data: await this.console.getCase(actor, id) };
  }

  @Post('cases/:id/claim')
  @Roles('agronomist', 'admin')
  @ApiOperation({
    summary:
      'CAS claim queued → assigned: exactly one concurrent claimant wins; the loser gets 409.'
  })
  async claimCase(@CurrentUser() actor: User | null, @Param('id') id: string) {
    return { data: await this.console.claimCase(actor, id) };
  }

  @Post('cases/:id/answer')
  @Roles('agronomist', 'admin')
  @ApiOperation({
    summary:
      'Record the answer and push it to the farmer via the SMS driver. Stub/unreachable channel: answer recorded, case stays assigned, delivery failed (retried by the sweep) — never marked answered until the channel confirms.'
  })
  async answerCase(
    @CurrentUser() actor: User | null,
    @Param('id') id: string,
    @Body() body: AnswerCaseDto
  ) {
    return { data: await this.console.answerCase(actor, id, body ?? { answerText: '' }) };
  }

  @Post('cases/:id/quality')
  @Roles('supervisor', 'admin')
  @ApiOperation({
    summary: 'Supervisor quality sampling (score 1–5; close=true closes the case).'
  })
  async scoreQuality(
    @CurrentUser() actor: User | null,
    @Param('id') id: string,
    @Body() body: ScoreQualityDto
  ) {
    return { data: await this.console.scoreQuality(actor, id, body ?? { score: 0 }) };
  }

  @Get('sla-report')
  @Roles('agronomist', 'supervisor', 'admin')
  @ApiOperation({
    summary: 'Per-cohort advisory SLA report (programme deliverable export).'
  })
  async slaReport(@CurrentUser() actor: User | null, @Query('cohort') cohort?: string) {
    return { data: await this.console.slaReport(actor, cohort) };
  }

  @Post('sla/sweep')
  @Roles('admin')
  @ApiOperation({
    summary:
      'Run one SLA sweep: flags breached cases (voice.escalation.sla_breached, once per case) and retries failed answer deliveries. External scheduler invokes this; the API starts no timers.'
  })
  async sweepSla() {
    return { data: await this.console.sweep() };
  }
}
