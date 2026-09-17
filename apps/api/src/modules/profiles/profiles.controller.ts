import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsNumber, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import type { LocationRef, User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ProfilesService, type UpsertProfileInput } from './profiles.service.js';

class LocationDto implements LocationRef {
  @IsString()
  @MaxLength(100)
  state!: string;

  @IsString()
  @MaxLength(100)
  lga!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
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
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  farmingInterests?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  valueChains?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
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
