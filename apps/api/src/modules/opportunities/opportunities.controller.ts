import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';
import {
  APPLICATION_STATUSES,
  type ApplicationStatus,
  type Opportunity
} from '@agric-platform/shared';
import { ActorId } from '../../common/auth/current-user.decorator.js';
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

@ApiTags('opportunities')
@Controller()
export class OpportunitiesController {
  constructor(
    private readonly opportunities: OpportunitiesService,
    private readonly audit: AuditService
  ) {}

  @Get('opportunities')
  @ApiOperation({ summary: 'List opportunities with state/value-chain/type filters' })
  list(@Query() query: ListOpportunitiesQuery) {
    return this.opportunities.list(query);
  }

  @Post('opportunities')
  @ApiOperation({ summary: 'Publish a new opportunity (partner or admin posting)' })
  create(@Body() dto: CreateOpportunityDto) {
    return { data: this.opportunities.create(dto) };
  }

  @Get('opportunities/recommended/:userId')
  @ApiOperation({ summary: 'Opportunities matching a user profile (state + value chains)' })
  recommended(@Param('userId') userId: string) {
    return { data: this.opportunities.recommendedFor(userId) };
  }

  @Get('opportunities/:id')
  @ApiOperation({ summary: 'Opportunity detail' })
  get(@Param('id') id: string) {
    return { data: this.opportunities.get(id) };
  }

  @Post('opportunities/:id/apply')
  @ApiOperation({ summary: 'Submit an application to an opportunity' })
  apply(@Param('id') id: string, @Body() dto: ApplyDto) {
    return { data: this.opportunities.apply(id, dto.userId, dto.notes) };
  }

  @Get('applications')
  @ApiOperation({ summary: 'List applications by user, opportunity or status' })
  listApplications(
    @Query('userId') userId?: string,
    @Query('opportunityId') opportunityId?: string,
    @Query('status') status?: ApplicationStatus
  ) {
    return { data: this.opportunities.listApplications({ userId, opportunityId, status }) };
  }

  @Get('applications/:id')
  @ApiOperation({ summary: 'Application detail' })
  getApplication(@Param('id') id: string) {
    return { data: this.opportunities.getApplication(id) };
  }

  @Patch('applications/:id/status')
  @ApiOperation({ summary: 'Transition an application status (review workflow)' })
  setApplicationStatus(
    @Param('id') id: string,
    @Body() dto: ApplicationStatusDto,
    @ActorId() actorId: string
  ) {
    const application = this.opportunities.setApplicationStatus(id, dto.status, actorId);
    this.audit.record({
      actorId,
      action: 'application.status_changed',
      entityType: 'application',
      entityId: id,
      metadata: { status: dto.status }
    });
    return { data: application };
  }
}
