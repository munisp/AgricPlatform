import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested
} from 'class-validator';
import type { LocationRef, User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ProfilesService, type UpsertProfileInput } from './profiles.service.js';

class LocationDto implements LocationRef {
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

class UpsertProfileDto implements UpsertProfileInput {
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto;

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
}

/**
 * Member profiles are personal data: every route requires the owning user
 * or an admin (ownership rule shared with the privacy module).
 */
@ApiTags('profiles')
@Controller('profiles')
@UseGuards(RolesGuard)
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get(':userId')
  @Authenticated()
  @ApiOperation({ summary: 'Get a member profile (own profile or admin)' })
  async get(@Param('userId') userId: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.profiles.get(userId) };
  }

  @Put(':userId')
  @Authenticated()
  @ApiOperation({ summary: 'Create or update a profile; recomputes the completion score (own profile or admin)' })
  async upsert(
    @Param('userId') userId: string,
    @Body() dto: UpsertProfileDto,
    @CurrentUser() actor: User | null
  ) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.profiles.upsert(userId, dto) };
  }

  @Get(':userId/completion')
  @Authenticated()
  @ApiOperation({ summary: 'Profile completion score, badge and missing fields (own profile or admin)' })
  async completion(@Param('userId') userId: string, @CurrentUser() actor: User | null) {
    assertSelfOrAdmin(actor, userId);
    return { data: await this.profiles.completion(userId) };
  }
}
