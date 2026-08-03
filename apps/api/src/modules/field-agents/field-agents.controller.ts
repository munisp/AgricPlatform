import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested
} from 'class-validator';
import {
  AGENT_ASSIGNMENT_STATUSES,
  type AgentAssignmentStatus,
  type LocationRef,
  type User
} from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { FieldAgentsService } from './field-agents.service.js';

class CreateAssignmentDto {
  @IsString()
  agentUserId!: string;

  @IsOptional()
  @IsString()
  farmerUserId?: string;

  @IsOptional()
  @IsString()
  chapterId?: string;

  @IsString()
  state!: string;

  @IsString()
  lga!: string;

  @IsOptional()
  @IsString()
  ward?: string;

  @IsString()
  purpose!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  targetCount?: number;

  @IsOptional()
  @IsString()
  dueAt?: string;
}

class ProgressDto {
  /** Increments completed_count; defaults to +1. Capped at the target. */
  @IsOptional()
  @IsInt()
  @Min(1)
  count?: number;
}

class CaptureLocationDto implements LocationRef {
  @IsString()
  state!: string;

  @IsString()
  lga!: string;

  @IsOptional()
  @IsString()
  ward?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;
}

class CaptureProfileDto {
  @IsOptional()
  @IsString()
  farmerUserId?: string;

  @IsOptional()
  @IsString()
  farmerPhone?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CaptureLocationDto)
  location?: CaptureLocationDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  farmingInterests?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  valueChains?: string[];

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsNumber()
  farmSizeHectares?: number;

  @IsOptional()
  @IsNumber()
  yearsExperience?: number;

  @IsOptional()
  @IsString()
  policyVersion?: string;
}

/**
 * Wave AGENTS field-agent (enumerator) endpoints. Assignment management is
 * admin/chapter-lead (chapter leads are scoped to their own chapters in the
 * service); the queue, progress reporting and on-behalf capture are
 * enumerator-only. Productivity aggregates are admin-only.
 */
@ApiTags('field-agents')
@Controller('field-agents')
@UseGuards(RolesGuard)
export class FieldAgentsController {
  constructor(private readonly fieldAgents: FieldAgentsService) {}

  @Post('assignments')
  @Roles('admin', 'chapter_lead')
  @ApiOperation({ summary: 'Create an enumerator assignment (admin or chapter lead)' })
  async createAssignment(@Body() dto: CreateAssignmentDto, @CurrentUser() actor: User | null) {
    return { data: await this.fieldAgents.createAssignment(actor, dto) };
  }

  @Get('assignments/mine')
  @Roles('enumerator')
  @ApiOperation({ summary: "The caller enumerator's open assignment queue" })
  async myQueue(@CurrentUser() actor: User | null) {
    return { data: await this.fieldAgents.myQueue(actor) };
  }

  @Get('assignments')
  @Roles('admin', 'chapter_lead')
  @ApiOperation({
    summary:
      'List assignments with optional filters (admin: all; chapter lead: own chapters/created only)'
  })
  async listAssignments(
    @CurrentUser() actor: User | null,
    @Query('agentUserId') agentUserId?: string,
    @Query('status') status?: string,
    @Query('state') state?: string,
    @Query('chapterId') chapterId?: string
  ) {
    // Fail closed: an unknown status filter is a client error, not "no filter".
    if (status !== undefined && !(AGENT_ASSIGNMENT_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(
        `status must be one of: ${AGENT_ASSIGNMENT_STATUSES.join(', ')}`
      );
    }
    return {
      data: await this.fieldAgents.listAssignments(actor, {
        ...(agentUserId ? { agentUserId } : {}),
        ...(status ? { status: status as AgentAssignmentStatus } : {}),
        ...(state ? { state } : {}),
        ...(chapterId ? { chapterId } : {})
      })
    };
  }

  @Post('assignments/:id/progress')
  @Roles('enumerator')
  @ApiOperation({
    summary: 'Report progress on an own assignment; auto-completes at the target count'
  })
  async reportProgress(
    @Param('id') id: string,
    @Body() dto: ProgressDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.fieldAgents.reportProgress(actor, id, dto?.count ?? 1) };
  }

  @Post('assignments/:id/cancel')
  @Roles('admin', 'chapter_lead')
  @ApiOperation({ summary: 'Cancel an open assignment (scoped for chapter leads)' })
  async cancel(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.fieldAgents.cancel(actor, id) };
  }

  @Get('productivity')
  @Roles('admin')
  @ApiOperation({ summary: 'Admin: per-agent completion rates and workload aggregates' })
  async productivity(@CurrentUser() actor: User | null) {
    return { data: await this.fieldAgents.productivity(actor) };
  }

  @Post('capture/profile')
  @Roles('enumerator')
  @ApiOperation({
    summary:
      "Enumerator: capture/update a farmer's profile on their behalf (records a " +
      "'field-data-capture' consent and attributes the capture to the agent)"
  })
  async captureProfile(@Body() dto: CaptureProfileDto, @CurrentUser() actor: User | null) {
    return { data: await this.fieldAgents.captureProfile(actor, dto) };
  }
}
