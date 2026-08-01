import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsISO8601, IsIn, IsOptional, IsString } from 'class-validator';
import type { Opportunity } from '@agric-platform/shared';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { PartnerService } from './partner.service.js';

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

@ApiTags('partner')
@Controller('partner/:partnerId')
@UseGuards(RolesGuard)
@Roles('partner', 'admin')
export class PartnerController {
  constructor(private readonly partner: PartnerService) {}

  @Get('programmes')
  @ApiOperation({ summary: 'Programmes/opportunities scoped to a partner' })
  programmes(@Param('partnerId') partnerId: string) {
    return { data: this.partner.programmes(partnerId) };
  }

  @Post('programmes')
  @ApiOperation({ summary: 'Publish a partner programme (audited)' })
  createProgramme(@Param('partnerId') partnerId: string, @Body() dto: CreateProgrammeDto) {
    return { data: this.partner.createProgramme(partnerId, dto) };
  }

  @Get('participants')
  @ApiOperation({ summary: 'Participants across the partner\'s programmes' })
  participants(@Param('partnerId') partnerId: string) {
    return { data: this.partner.participants(partnerId) };
  }

  @Get('reports/impact')
  @ApiOperation({ summary: 'Partner impact report (applications, participants, training)' })
  impactReport(@Param('partnerId') partnerId: string) {
    return { data: this.partner.impactReport(partnerId) };
  }
}
