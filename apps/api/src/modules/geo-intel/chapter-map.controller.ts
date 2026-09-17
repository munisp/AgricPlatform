import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RequiresFeature } from '../../common/feature-flags/feature-flag.decorator.js';
import { FeatureFlagGuard } from '../../common/feature-flags/feature-flag.guard.js';
import {
  CHAPTER_MAP_METRICS,
  type ChapterMapMetric
} from '../../database/repositories/chapter-map.repository.js';
import { ChapterMapService } from './chapter-map.service.js';

class ChapterMapQueryDto {
  @IsOptional()
  @IsIn([...CHAPTER_MAP_METRICS])
  metric?: ChapterMapMetric;
}

/**
 * Chapter Map ops surface (Innovation 10, Stage 27). Flag-gated
 * ('chapter-map', default OFF — the guard fails closed with 404), role
 * guarded to chapter leads and platform admins. Responses carry k-anonymised
 * aggregates only: cells below the floor (5 members) are suppressed and no
 * farmer PII is ever returned.
 */
@ApiTags('chapters')
@Controller('chapters')
export class ChapterMapController {
  constructor(private readonly chapterMap: ChapterMapService) {}

  @Get(':id/map')
  @Roles('admin', 'chapter_lead')
  @RequiresFeature('chapter-map')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @ApiOperation({
    summary:
      'Chapter map: per-cell H3 res-7 aggregates (members, plots, voucher redemptions, ' +
      'mechanization coverage, pending escrow). k-anonymised; stale snapshots are badged, never live.'
  })
  async getMap(
    @Param('id') id: string,
    @Query() query: ChapterMapQueryDto,
    @CurrentUser() actor: User | null
  ) {
    await this.chapterMap.assertMapReader(actor, id);
    return { data: await this.chapterMap.getMap(id, query.metric) };
  }

  @Post(':id/map/recompute')
  @Roles('admin')
  @RequiresFeature('chapter-map')
  @UseGuards(RolesGuard, FeatureFlagGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Recompute chapter map snapshots from the domain tables (admin; rate-limited; ' +
      'idempotent PK upsert into the recomputable cache).'
  })
  async recompute(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.chapterMap.recompute(id, actor?.id) };
  }
}
