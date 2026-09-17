import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Query,
  ServiceUnavailableException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import {
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError
} from '../integrations/drivers/http.js';
import { SEARCH_PROVIDER, type SearchProvider } from './search.provider.js';
import { type SearchResultType } from './search.service.js';

/**
 * WP-G10 error-mapping doctrine: a configured live search backend that
 * fails (timeout, transport, non-2xx, open circuit) is a SERVICE
 * AVAILABILITY problem — callers get 503, never 500. The provider error
 * detail stays in logs/traces (A3-7: provider bodies can echo request
 * data); the client gets a generic message. Non-provider errors rethrow
 * unchanged.
 */
export function mapSearchProviderFailure(error: unknown): never {
  if (
    error instanceof ProviderConfigError ||
    error instanceof ProviderHttpError ||
    error instanceof ProviderRequestError
  ) {
    throw new ServiceUnavailableException(
      'Search is temporarily unavailable: the configured search backend could not ' +
        'serve the request. Try again later.'
    );
  }
  throw error;
}

/** Runs a provider call, mapping backend failures to 503 (WP-G10). */
async function withSearchProviderMapping<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    mapSearchProviderFailure(error);
  }
}

const RESULT_TYPES: SearchResultType[] = ['course', 'opportunity', 'listing', 'advisory', 'chapter', 'topic'];

class SearchQuery {
  @IsString()
  @MaxLength(500)
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
  @MaxLength(100)
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
  @MaxLength(100)
  type!: SearchResultType;

  @IsString()
  @MaxLength(100)
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
  // Wave FABRIC: queries go through the SearchProvider port — the in-process
  // SearchService by default, the OpenSearch driver when SEARCH_DRIVER=
  // opensearch is selected (fail-closed at boot without OPENSEARCH_NODE).
  constructor(
    @Inject(SEARCH_PROVIDER) private readonly searchService: SearchProvider
  ) {}

  @Get()
  @ApiOperation({ summary: 'Cross-domain search across courses, opportunities, listings, advisory, chapters, topics' })
  async search(@Query() query: SearchQuery) {
    return {
      data: await withSearchProviderMapping(() =>
        this.searchService.search(query.q, query.types, query.state, query.limit)
      )
    };
  }

  @Get('suggest')
  @ApiOperation({ summary: 'Title suggestions for a partial query' })
  async suggest(@Query('q') q: string) {
    return {
      data: await withSearchProviderMapping(() => this.searchService.suggest(q ?? ''))
    };
  }

  @Get('trending')
  @ApiOperation({ summary: 'Trending queries (decayed counts over a trailing 7-day window)' })
  async trending(@Query() query: TrendingQueryDto) {
    return {
      data: await withSearchProviderMapping(() =>
        this.searchService.trending({ limit: query.limit })
      )
    };
  }

  @Get('related')
  @ApiOperation({ summary: 'Related items by shared-tag co-occurrence' })
  async related(@Query() query: RelatedQuery) {
    if (!RESULT_TYPES.includes(query.type)) {
      throw new NotFoundException(`Unknown result type '${query.type}'`);
    }
    return {
      data: await withSearchProviderMapping(() =>
        this.searchService.related(query.type, query.id, query.limit)
      )
    };
  }

  // WP-G10: driver diagnostics disclose which backend serves search —
  // admin-only, same doctrine as /health/modules (G14) and the ledger
  // backend-status endpoint. The in-process fan-out reports driver
  // 'in-process' (external search disabled), never a fabricated live status.
  @Get('driver-status')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Search driver status (admin, diagnostics; WP-G10)' })
  async driverStatus() {
    const status = await this.searchService.status?.();
    return {
      data: status
        ? {
            driver: (this.searchService as SearchProvider & { name?: string }).name ?? 'live',
            ...status
          }
        : {
            driver: 'in-process',
            configured: true,
            healthy: true,
            detail:
              'In-process repository fan-out (SearchService); no external search driver ' +
              'selected. Set SEARCH_DRIVER=opensearch or meilisearch for a live backend.'
          }
    };
  }
}
