import { Controller, Get, Query } from '@nestjs/common';
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

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Cross-domain search across courses, opportunities, listings, advisory, chapters, topics' })
  search(@Query() query: SearchQuery) {
    return {
      data: this.searchService.search(query.q, query.types, query.state, query.limit)
    };
  }

  @Get('suggest')
  @ApiOperation({ summary: 'Title suggestions for a partial query' })
  suggest(@Query('q') q: string) {
    return { data: this.searchService.suggest(q ?? '') };
  }
}
