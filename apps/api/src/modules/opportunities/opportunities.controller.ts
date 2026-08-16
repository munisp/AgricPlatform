import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';
import {
  APPLICATION_STATUSES,
  type ApplicationStatus,
  type Opportunity,
  type User,
  type UserRole
} from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import { AuditService } from '../../core/audit.service.js';
import {
  OpportunitiesService,
  type CreateOpportunityInput
} from './opportunities.service.js';

const OPPORTUNITY_TYPES = [
  'grant',
  'loan',
  'programme',
  'job',
  'internship',
  'competition',
  'equipment',
  'land'
] as const;

/** Roles allowed to review applications and publish opportunities. */
const OPPORTUNITY_STAFF: UserRole[] = ['admin', 'partner'];

class ListOpportunitiesQuery extends ListQueryDto {
  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  valueChain?: string;

  @IsOptional()
  @IsIn(OPPORTUNITY_TYPES)
  type?: Opportunity['type'];

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  active?: boolean;
}

class CreateOpportunityDto implements CreateOpportunityInput {
  @IsString()
  title!: string;

  @IsIn(OPPORTUNITY_TYPES)
  type!: Opportunity['type'];

  @IsString()
  description!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  states?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  valueChains?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  eligibility?: string[];

  @IsISO8601()
  deadline!: string;

  @IsOptional()
  @IsString()
  partnerId?: string;
}

class ApplyDto {
  @IsString()
  userId!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

class ApplicationStatusDto {
  @IsIn(APPLICATION_STATUSES)
  status!: ApplicationStatus;
}

/**
 * Opportunity catalog is public (no user data). Applications are personal
 * records: applying/listing/reading requires the owning user or an admin,
 * and publishing + status transitions are staff-only (admin/partner).
 */
@ApiTags('opportunities')
@Controller()
@UseGuards(RolesGuard)
export class OpportunitiesController {
  constructor(
    private readonly opportunities: OpportunitiesService,
    private readonly audit: AuditService
  ) {}

  @Get('opportunities')
  @ApiOperation({ summary: 'List opportunities with state/value-chain/type filters (public catalog)' })
  list(@Query() query: ListOpportunitiesQuery) {
    return this.opportunities.list(query);
  }

  @Post('opportunities')
  @Roles(...OPPORTUNITY_STAFF)
  @ApiOperation({ summary: 'Publish a new opportunity (partner or admin posting)' })
  async create(@Body() dto: CreateOpportunityDto) {
    return { data: await this.opportunities.create(dto) };
  }

  @Get('opportunities/recommended/:userId')
  @Authenticated()
  @ApiOperation({ summary: 'Opportunities matching a user profile (own record or admin)' })
  async recommended(@Param('userId') userId: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.opportunities.recommendedFor(userId) };
  }

  @Get('opportunities/:id')
  @ApiOperation({ summary: 'Opportunity detail (public catalog)' })
  async get(@Param('id') id: string) {
    return { data: await this.opportunities.get(id) };
  }

  @Post('opportunities/:id/apply')
  @Authenticated()
  @ApiOperation({ summary: 'Submit an application to an opportunity (own user or admin)' })
  async apply(@Param('id') id: string, @Body() dto: ApplyDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return { data: await this.opportunities.apply(id, dto.userId, dto.notes) };
  }

  @Get('applications')
  @Authenticated()
  @ApiOperation({ summary: 'List applications by user, opportunity or status (own records or staff)' })
  async listApplications(
    @CurrentUser() actor: User | null,
    @Query('userId') userId?: string,
    @Query('opportunityId') opportunityId?: string,
    @Query('status') status?: ApplicationStatus
  ) {
    if (userId) {
      assertSelfOrAdmin(actor, userId);
    } else if (!actor?.roles.some((role) => OPPORTUNITY_STAFF.includes(role))) {
      throw new ForbiddenException(
        'Listing applications across users requires the admin or partner role'
      );
    }
    return { data: await this.opportunities.listApplications({ userId, opportunityId, status }) };
  }

  @Get('applications/:id')
  @Authenticated()
  @ApiOperation({ summary: 'Application detail (owning user or staff)' })
  async getApplication(@Param('id') id: string, @CurrentUser() actor: User | null) {
    const application = await this.opportunities.getApplication(id);
    if (!actor?.roles.some((role) => OPPORTUNITY_STAFF.includes(role))) {
      assertSelfOrAdmin(actor, application.userId);
    }
    return { data: application };
  }

  @Patch('applications/:id/status')
  @Roles(...OPPORTUNITY_STAFF)
  @ApiOperation({ summary: 'Transition an application status (admin/partner review workflow)' })
  async setApplicationStatus(
    @Param('id') id: string,
    @Body() dto: ApplicationStatusDto,
    @CurrentUser() actor: User | null
  ) {
    const actorId = actor?.id ?? 'anonymous';
    const application = await this.opportunities.setApplicationStatus(id, dto.status, actorId);
    await this.audit.record({
      actorId,
      action: 'application.status_changed',
      entityType: 'application',
      entityId: id,
      metadata: { status: dto.status }
    });
    return { data: application };
  }
}
