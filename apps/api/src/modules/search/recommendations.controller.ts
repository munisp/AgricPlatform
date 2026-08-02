import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { RecommendationService } from './recommendation.service.js';
import { RECOMMENDATION_TYPES, type RecommendationType } from './recommender.js';

class RecommendationsQuery {
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

class FeedbackDto {
  @IsIn(RECOMMENDATION_TYPES)
  type!: RecommendationType;

  @IsIn(['clicked', 'dismissed'])
  action!: 'clicked' | 'dismissed';
}

function requireUser(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

function parseType(raw: string): RecommendationType {
  if (!(RECOMMENDATION_TYPES as readonly string[]).includes(raw)) {
    throw new BadRequestException(
      `Unknown recommendation type '${raw}'; expected one of ${RECOMMENDATION_TYPES.join(', ')}`
    );
  }
  return raw as RecommendationType;
}

@ApiTags('recommendations')
@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationService) {}

  @Get()
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({
    summary:
      'Per-member content recommendations (courses, opportunities, listings, knowledge) with per-item reason codes. Cold-start members receive the trending fallback.'
  })
  async forMember(@CurrentUser() actor: User | null, @Query() query: RecommendationsQuery) {
    const user = requireUser(actor);
    return { data: await this.recommendations.recommendFor(user.id, { limit: query.limit }) };
  }

  @Get('similar/:type/:id')
  @ApiOperation({ summary: 'Items similar to the given content item, with reason codes' })
  async similar(@Param('type') type: string, @Param('id') id: string, @Query() query: RecommendationsQuery) {
    return { data: await this.recommendations.similar(parseType(type), id, query.limit) };
  }

  @Post(':id/feedback')
  @UseGuards(RolesGuard)
  @Authenticated()
  @ApiOperation({
    summary: 'Record clicked/dismissed feedback for a recommended item; adjusts future ranking'
  })
  async feedback(
    @CurrentUser() actor: User | null,
    @Param('id') id: string,
    @Body() dto: FeedbackDto
  ) {
    const user = requireUser(actor);
    return { data: await this.recommendations.recordFeedback(user.id, dto.type, id, dto.action) };
  }
}
