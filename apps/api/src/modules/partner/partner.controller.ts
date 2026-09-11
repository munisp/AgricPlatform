import { Body, Controller, Get, Param, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsISO8601, IsIn, IsOptional, IsString } from 'class-validator';
import type { Opportunity, User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { PartnerService } from './partner.service.js';

/** Fail-closed actor resolution (RolesGuard populates request.user). */
function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

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

class CreateProgrammeDto {
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
}

/**
 * Partner-organisation portal. The class guard authenticates the caller and
 * requires the partner/admin role; the service additionally binds non-admin
 * callers to the `:partnerId` tenant via partners.partner_members
 * (Stage 24, audit A2-1) so one partner organisation can never act on —
 * or read applicants of — another.
 */
@ApiTags('partner')
@Controller('partner/:partnerId')
@UseGuards(RolesGuard)
@Roles('partner', 'admin')
export class PartnerController {
  constructor(private readonly partner: PartnerService) {}

  @Get('programmes')
  @ApiOperation({ summary: 'Programmes/opportunities scoped to a partner' })
  async programmes(@Param('partnerId') partnerId: string, @CurrentUser() actor: User | null) {
    return { data: await this.partner.programmes(requireActor(actor), partnerId) };
  }

  @Post('programmes')
  @ApiOperation({ summary: 'Publish a partner programme (audited)' })
  async createProgramme(
    @Param('partnerId') partnerId: string,
    @Body() dto: CreateProgrammeDto,
    @CurrentUser() actor: User | null
  ) {
    return { data: await this.partner.createProgramme(requireActor(actor), partnerId, dto) };
  }

  @Get('participants')
  @ApiOperation({ summary: 'Participants across the partner\'s programmes' })
  async participants(@Param('partnerId') partnerId: string, @CurrentUser() actor: User | null) {
    return { data: await this.partner.participants(requireActor(actor), partnerId) };
  }

  @Get('reports/impact')
  @ApiOperation({ summary: 'Partner impact report (applications, participants, training)' })
  async impactReport(@Param('partnerId') partnerId: string, @CurrentUser() actor: User | null) {
    return { data: await this.partner.impactReport(requireActor(actor), partnerId) };
  }
}
