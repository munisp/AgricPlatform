import { Controller, Get, NotFoundException, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { SearchService, type SearchResultType } from './search.service.js';

const RESULT_TYPES: SearchResultType[] = ['course', 'opportunity', 'listing', 'advisory', 'chapter', 'topic'];

class SearchQuery {
  @IsString()
  q!: string;

  @IsOptional()
  @Transform(({ value }: { value: string }) =>
    (value ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => RESULT_TYPES.includes(v as SearchResultType))
  )
  types?: SearchResultType[];

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

class TrendingQueryDto {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

class RelatedQuery {
  @IsString()
  type!: SearchResultType;

  @IsString()
  id!: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Cross-domain search across courses, opportunities, listings, advisory, chapters, topics' })
  async search(@Query() query: SearchQuery) {
    return {
      data: await this.searchService.search(query.q, query.types, query.state, query.limit)
    };
  }

  @Get('suggest')
  @ApiOperation({ summary: 'Title suggestions for a partial query' })
  async suggest(@Query('q') q: string) {
    return { data: await this.searchService.suggest(q ?? '') };
  }

  @Get('trending')
  @ApiOperation({ summary: 'Trending queries (decayed counts over a trailing 7-day window)' })
  async trending(@Query() query: TrendingQueryDto) {
    return { data: await this.searchService.trending({ limit: query.limit }) };
  }

  @Get('related')
  @ApiOperation({ summary: 'Related items by shared-tag co-occurrence' })
  async related(@Query() query: RelatedQuery) {
    if (!RESULT_TYPES.includes(query.type)) {
      throw new NotFoundException(`Unknown result type '${query.type}'`);
    }
    return { data: await this.searchService.related(query.type, query.id, query.limit) };
  }
}
