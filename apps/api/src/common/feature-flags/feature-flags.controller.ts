import { Body, Controller, Delete, Get, NotFoundException, Param, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Authenticated, Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { FeatureFlagsService } from './feature-flags.service.js';

const FLAG_KEY_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;

class UpsertFeatureFlagDto {
  @IsString()
  @Matches(FLAG_KEY_PATTERN, { message: 'Flag keys use dotted lowercase segments, e.g. notifications.sse' })
  @MaxLength(120)
  key!: string;

  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString({ each: true })
  @ArrayMaxSize(16)
  roleAllowlist?: string[];

  @IsInt()
  @Min(0)
  @Max(100)
  percentage!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

/**
 * Feature-flag administration (Wave P). Reads/evaluation for the current
 * caller are available to any authenticated identity; CRUD is admin-only.
 */
@ApiTags('feature-flags')
@Controller('feature-flags')
@UseGuards(RolesGuard)
export class FeatureFlagsController {
  constructor(private readonly flags: FeatureFlagsService) {}

  @Get()
  @Roles('admin')
  @ApiOperation({ summary: 'List all feature flags (admin)' })
  async list() {
    return { data: await this.flags.list() };
  }

  @Get(':key/evaluate')
  @Authenticated()
  @ApiOperation({ summary: 'Evaluate a flag for the current caller (fail-closed)' })
  async evaluate(@Param('key') key: string, @CurrentUser() actor: User | null) {
    const enabled = await this.flags.isEnabled(key, { userId: actor?.id, roles: actor?.roles });
    return { data: { key, enabled } };
  }

  @Put(':key')
  @Roles('admin')
  @ApiOperation({ summary: 'Create or update a feature flag (admin)' })
  async upsert(@Param('key') key: string, @Body() dto: UpsertFeatureFlagDto) {
    if (dto.key !== key) {
      throw new NotFoundException(`Body key '${dto.key}' does not match path key '${key}'`);
    }
    return {
      data: await this.flags.upsert({
        key,
        enabled: dto.enabled,
        roleAllowlist: dto.roleAllowlist ?? [],
        percentage: dto.percentage,
        description: dto.description ?? ''
      })
    };
  }

  @Delete(':key')
  @Roles('admin')
  @ApiOperation({ summary: 'Delete a feature flag (admin)' })
  async remove(@Param('key') key: string) {
    const removed = await this.flags.remove(key);
    if (!removed) {
      throw new NotFoundException(`Unknown feature flag '${key}'`);
    }
    return { data: { key, removed } };
  }
}
