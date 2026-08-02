import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, Min } from 'class-validator';
import type { CohortStatus, MilestoneProgressStatus, ProgrammeType, User } from '@agric-platform/shared';
import { COHORT_STATUSES, MILESTONE_PROGRESS_STATUSES, PROGRAMME_TYPES } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import {
  ProgrammesService,
  type CreateCohortInput,
  type EnrolInput
} from './programmes.service.js';

class ListCohortsQuery extends ListQueryDto {
  @IsOptional()
  @IsIn(PROGRAMME_TYPES)
  programmeType?: ProgrammeType;

  @IsOptional()
  @IsIn(COHORT_STATUSES)
  status?: CohortStatus;
}

class CreateCohortDto implements CreateCohortInput {
  @IsString()
  name!: string;

  @IsIn(PROGRAMME_TYPES)
  programmeType!: ProgrammeType;

  @IsInt()
  @Min(1)
  capacity!: number;

  @IsISO8601()
  enrolmentOpensAt!: string;

  @IsISO8601()
  enrolmentClosesAt!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  moderatorIds?: string[];
}

class SetCohortStatusDto {
  @IsIn(COHORT_STATUSES)
  status!: CohortStatus;
}

class EnrolDto implements EnrolInput {
  @IsString()
  userId!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  declaredAge?: number;

  @IsOptional()
  @IsIn(['female', 'male', 'other'])
  declaredGender?: 'female' | 'male' | 'other';
}

class AddMilestoneDto {
  @IsString()
  title!: string;

  @IsInt()
  @Min(1)
  sequence!: number;

  @IsOptional()
  @IsISO8601()
  dueAt?: string;
}

class SetProgressDto {
  @IsString()
  userId!: string;

  @IsIn(MILESTONE_PROGRESS_STATUSES)
  status!: MilestoneProgressStatus;
}

class AddCriterionDto {
  @IsString()
  name!: string;

  @IsInt()
  @Min(1)
  maxScore!: number;
}

class AssignJudgeDto {
  @IsString()
  judgeUserId!: string;
}

class SubmitScoreDto {
  @IsString()
  judgeUserId!: string;

  @IsString()
  entryUserId!: string;

  @IsString()
  criterionId!: string;

  @IsInt()
  @Min(0)
  score!: number;
}

class CreateThreadDto {
  @IsString()
  title!: string;
}

class CreatePostDto {
  @IsString()
  body!: string;
}

@ApiTags('programmes')
@Controller()
export class ProgrammesController {
  constructor(private readonly programmes: ProgrammesService) {}

  @Get('programme-cohorts')
  @ApiOperation({ summary: 'List women/youth programme cohorts' })
  listCohorts(@Query() query: ListCohortsQuery) {
    return this.programmes.listCohorts(query);
  }

  @Post('programme-cohorts')
  @UseGuards(RolesGuard)
  @Roles('admin', 'partner')
  @ApiOperation({ summary: 'Create a cohort (partners and admins)' })
  async createCohort(@Body() dto: CreateCohortDto, @CurrentUser() actor: User | null) {
    return { data: await this.programmes.createCohort(dto, actor?.id ?? 'anonymous') };
  }

  @Get('programme-cohorts/:id')
  @ApiOperation({ summary: 'Cohort detail' })
  async getCohort(@Param('id') id: string) {
    return { data: await this.programmes.getCohort(id) };
  }

  @Post('programme-cohorts/:id/status')
  @UseGuards(RolesGuard)
  @Roles('admin', 'partner')
  @ApiOperation({ summary: 'Drive the cohort lifecycle (draft → open → closed → active → completed)' })
  async setCohortStatus(@Param('id') id: string, @Body() dto: SetCohortStatusDto, @CurrentUser() actor: User | null) {
    return { data: await this.programmes.setCohortStatus(id, dto.status, actor?.id ?? 'anonymous') };
  }

  @Post('programme-cohorts/:id/enrolments')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Enrol in a cohort with declared attributes (own enrolment)' })
  async enrol(@Param('id') id: string, @Body() dto: EnrolDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return { data: await this.programmes.enrol(id, dto) };
  }

  @Get('programme-cohorts/:id/enrolments')
  @UseGuards(RolesGuard)
  @Roles('admin', 'partner')
  @ApiOperation({ summary: 'List cohort enrolments (partners and admins)' })
  async listEnrolments(@Param('id') id: string) {
    return { data: await this.programmes.listEnrolments(id) };
  }

  @Post('programme-cohorts/:id/enrolments/withdraw')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Withdraw own enrolment from a cohort' })
  async withdraw(@Param('id') id: string, @Body() dto: EnrolDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return { data: await this.programmes.withdrawEnrolment(id, dto.userId, actor ?? { id: 'anonymous', roles: [] }) };
  }

  @Post('programme-cohorts/:id/milestones')
  @UseGuards(RolesGuard)
  @Roles('admin', 'partner')
  @ApiOperation({ summary: 'Add a programme milestone (partners and admins)' })
  async addMilestone(@Param('id') id: string, @Body() dto: AddMilestoneDto, @CurrentUser() actor: User | null) {
    return { data: await this.programmes.addMilestone(id, dto, actor?.id ?? 'anonymous') };
  }

  @Get('programme-cohorts/:id/milestones')
  @ApiOperation({ summary: 'List cohort milestones in sequence order' })
  async listMilestones(@Param('id') id: string) {
    return { data: await this.programmes.listMilestones(id) };
  }

  @Post('programme-milestones/:id/progress')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Update own milestone progress' })
  async setProgress(@Param('id') id: string, @Body() dto: SetProgressDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return {
      data: await this.programmes.setMilestoneProgress(id, dto.userId, dto.status, actor ?? { id: 'anonymous', roles: [] })
    };
  }

  @Get('programme-cohorts/:id/progress')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Milestone progress for a member (own records or admin)' })
  async progressForUser(@Param('id') id: string, @Query('userId') userId: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.programmes.progressForUser(id, userId) };
  }

  @Post('programme-cohorts/:id/rubric')
  @UseGuards(RolesGuard)
  @Roles('admin', 'partner')
  @ApiOperation({ summary: 'Add a judging rubric criterion (partners and admins)' })
  async addCriterion(@Param('id') id: string, @Body() dto: AddCriterionDto, @CurrentUser() actor: User | null) {
    return { data: await this.programmes.addRubricCriterion(id, dto, actor?.id ?? 'anonymous') };
  }

  @Post('programme-cohorts/:id/judges')
  @UseGuards(RolesGuard)
  @Roles('admin', 'partner')
  @ApiOperation({ summary: 'Assign a judge to a cohort (partners and admins)' })
  async assignJudge(@Param('id') id: string, @Body() dto: AssignJudgeDto, @CurrentUser() actor: User | null) {
    return { data: await this.programmes.assignJudge(id, dto.judgeUserId, actor?.id ?? 'anonymous') };
  }

  @Post('programme-cohorts/:id/scores')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Submit a judge score (unique per judge + entry + criterion)' })
  async submitScore(@Param('id') id: string, @Body() dto: SubmitScoreDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.judgeUserId);
    return {
      data: await this.programmes.submitScore(id, dto.judgeUserId, dto.entryUserId, dto.criterionId, dto.score)
    };
  }

  @Get('programme-cohorts/:id/leaderboard')
  @ApiOperation({ summary: 'Cohort judging leaderboard' })
  async leaderboard(@Param('id') id: string) {
    return { data: await this.programmes.leaderboard(id) };
  }

  @Get('programme-cohorts/:id/threads')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'List protected-space threads (enrolled members and moderators only)' })
  async listThreads(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.programmes.listThreads(id, actor ?? { id: 'anonymous', roles: [] }) };
  }

  @Post('programme-cohorts/:id/threads')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Open a protected-space thread (enrolled members and moderators only)' })
  async createThread(@Param('id') id: string, @Body() dto: CreateThreadDto, @CurrentUser() actor: User | null) {
    return { data: await this.programmes.createThread(id, dto.title, actor ?? { id: 'anonymous', roles: [] }) };
  }

  @Get('programme-threads/:id/posts')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'List posts in a protected-space thread' })
  async listPosts(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.programmes.listThreadPosts(id, actor ?? { id: 'anonymous', roles: [] }) };
  }

  @Post('programme-threads/:id/posts')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Post to a protected-space thread' })
  async createPost(@Param('id') id: string, @Body() dto: CreatePostDto, @CurrentUser() actor: User | null) {
    return { data: await this.programmes.postToThread(id, dto.body, actor ?? { id: 'anonymous', roles: [] }) };
  }
}
