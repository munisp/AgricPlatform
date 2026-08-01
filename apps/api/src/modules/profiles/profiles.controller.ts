import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested
} from 'class-validator';
import type { LocationRef } from '@agric-platform/shared';
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

@ApiTags('profiles')
@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get(':userId')
  @ApiOperation({ summary: 'Get a member profile' })
  async get(@Param('userId') userId: string) {
    return { data: await this.profiles.get(userId) };
  }

  @Put(':userId')
  @ApiOperation({ summary: 'Create or update a profile; recomputes the completion score' })
  async upsert(@Param('userId') userId: string, @Body() dto: UpsertProfileDto) {
    return { data: await this.profiles.upsert(userId, dto) };
  }

  @Get(':userId/completion')
  @ApiOperation({ summary: 'Profile completion score, badge and missing fields' })
  async completion(@Param('userId') userId: string) {
    return { data: await this.profiles.completion(userId) };
  }
}
