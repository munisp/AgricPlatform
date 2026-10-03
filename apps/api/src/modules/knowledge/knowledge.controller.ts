import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { LANGUAGE_CODES, type LanguageCode, type User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Public, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import { KnowledgeService, type CreateArticleInput } from './knowledge.service.js';

class ListArticlesQuery extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  category?: string;

  @IsOptional()
  @IsIn(LANGUAGE_CODES)
  language?: LanguageCode;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  crop?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  q?: string;
}

class CreateArticleDto implements CreateArticleInput {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsString()
  @MaxLength(500)
  category!: string;

  @IsString()
  @MaxLength(20000)
  body!: string;

  @IsIn(LANGUAGE_CODES)
  language!: LanguageCode;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  crops?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  tags?: string[];
}

class ReviewDto {
  @IsIn(['approved', 'rejected'])
  status!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNote?: string;
}

/**
 * Knowledge base (agronomy articles). Published articles are a public
 * catalogue; authoring is agronomist/admin, review is admin-only.
 */
@ApiTags('knowledge')
@Controller('knowledge')
@UseGuards(RolesGuard)
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get('articles')
  @Public()
  @ApiOperation({ summary: 'List published knowledge articles (public catalogue)' })
  list(@Query() query: ListArticlesQuery) {
    return this.knowledge.listPublished(query);
  }

  @Post('articles')
  @Roles('admin', 'agronomist')
  @ApiOperation({ summary: 'Submit an article for review (agronomist/admin)' })
  async create(@Body() dto: CreateArticleDto, @CurrentUser() actor: User | null) {
    return { data: await this.knowledge.create(dto, actor?.id ?? 'anonymous') };
  }

  @Get('articles/pending')
  @Roles('admin')
  @ApiOperation({ summary: 'Review queue: articles awaiting moderation (admin)' })
  async pending() {
    return { data: await this.knowledge.listPending() };
  }

  @Get('articles/:id')
  @Public()
  @ApiOperation({ summary: 'Article detail (published articles are public)' })
  async get(@Param('id') id: string, @CurrentUser() actor: User | null) {
    return { data: await this.knowledge.get(id, actor) };
  }

  @Post('articles/:id/review')
  @Roles('admin')
  @ApiOperation({ summary: 'Approve or reject a submitted article (admin moderation)' })
  async review(@Param('id') id: string, @Body() dto: ReviewDto, @CurrentUser() actor: User | null) {
    return { data: await this.knowledge.review(id, dto.status, actor?.id ?? 'anonymous', dto.reviewNote) };
  }
}
