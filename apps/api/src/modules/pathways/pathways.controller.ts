import { Body, Controller, Get, Param, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { ClubMemberRole, PathwayTrack, User } from '@agric-platform/shared';
import { CLUB_MEMBER_ROLES, PATHWAY_TRACKS } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { PathwaysService, type CreateClubInput, type CreateTemplateInput } from './pathways.service.js';

class TemplateStageDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  requiredActions?: string[];
}

class CreateTemplateDto implements CreateTemplateInput {
  @IsIn(PATHWAY_TRACKS)
  track!: PathwayTrack;

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateStageDto)
  stages!: TemplateStageDto[];
}

class EnrolPathwayDto {
  @IsString()
  @MaxLength(100)
  userId!: string;
}

class CompleteStageDto {
  @IsString()
  @MaxLength(500)
  evidence!: string;
}

class ListClubsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  institution?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isNyscCdsGroup?: boolean;
}

class CreateClubDto implements CreateClubInput {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(500)
  institution!: string;

  @IsString()
  @MaxLength(100)
  state!: string;

  @IsString()
  @MaxLength(100)
  coordinatorUserId!: string;

  @IsOptional()
  @IsBoolean()
  isNyscCdsGroup?: boolean;
}

class JoinClubDto {
  @IsString()
  @MaxLength(100)
  userId!: string;

  @IsOptional()
  @IsIn(CLUB_MEMBER_ROLES)
  role?: ClubMemberRole;
}

@ApiTags('pathways')
@Controller()
export class PathwaysController {
  constructor(private readonly pathways: PathwaysService) {}

  @Get('pathway-templates')
  @ApiOperation({ summary: 'List student/NYSC pathway templates' })
  listTemplates(@Query('track') track?: PathwayTrack) {
    return this.pathways.listTemplates(track);
  }

  @Post('pathway-templates')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Create a pathway template with stages (admin only)' })
  async createTemplate(@Body() dto: CreateTemplateDto, @CurrentUser() actor: User | null) {
    return { data: await this.pathways.createTemplate(dto, actor?.id ?? 'anonymous') };
  }

  @Get('pathway-templates/:id')
  @ApiOperation({ summary: 'Pathway template detail with stages' })
  async getTemplate(@Param('id') id: string) {
    return { data: await this.pathways.getTemplate(id) };
  }

  @Post('pathway-templates/:id/enrol')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Enrol on a pathway (own enrolment)' })
  async enrol(@Param('id') id: string, @Body() dto: EnrolPathwayDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return { data: await this.pathways.enrol(id, dto.userId) };
  }

  // Declared before `pathway-enrolments/:id` so 'mine' is not captured as an id.
  @Get('pathway-enrolments/mine')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'List the current user\'s pathway enrolments with template and stage progress summary' })
  async listMyEnrolments(@CurrentUser() actor: User | null) {
    if (!actor) {
      throw new UnauthorizedException('Authentication required');
    }
    return { data: await this.pathways.listMyEnrolments(actor.id) };
  }

  @Get('pathway-enrolments/:id')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Pathway enrolment detail with stage progress' })
  async getEnrolment(@Param('id') id: string) {
    return { data: await this.pathways.getEnrolment(id) };
  }

  @Post('pathway-enrolments/:id/complete-stage')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Complete the current stage with evidence and advance' })
  async completeStage(@Param('id') id: string, @Body() dto: CompleteStageDto, @CurrentUser() actor: User | null) {
    return { data: await this.pathways.completeCurrentStage(id, dto.evidence, actor ?? { id: 'anonymous', roles: [] }) };
  }

  @Get('campus-clubs')
  @ApiOperation({ summary: 'List campus clubs (state / institution / NYSC CDS filter)' })
  listClubs(@Query() query: ListClubsQuery) {
    return this.pathways.listClubs(query);
  }

  @Post('campus-clubs')
  @UseGuards(RolesGuard)
  @Roles('admin', 'chapter_lead', 'partner')
  @ApiOperation({ summary: 'Register a campus club (coordinator becomes first member)' })
  async createClub(@Body() dto: CreateClubDto, @CurrentUser() actor: User | null) {
    return { data: await this.pathways.createClub(dto, actor?.id ?? 'anonymous') };
  }

  @Get('campus-clubs/:id')
  @ApiOperation({ summary: 'Campus club detail with member roster' })
  async getClub(@Param('id') id: string) {
    return { data: await this.pathways.getClub(id) };
  }

  @Post('campus-clubs/:id/members')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({ summary: 'Join a campus club (own membership)' })
  async joinClub(@Param('id') id: string, @Body() dto: JoinClubDto, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, dto.userId);
    return { data: await this.pathways.joinClub(id, dto.userId, dto.role) };
  }
}
