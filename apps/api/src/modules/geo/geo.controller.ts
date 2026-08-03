import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf
} from 'class-validator';
import type { User } from '@agric-platform/shared';
import { GEO_BOUNDARY_KINDS, H3_RESOLUTIONS } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Authenticated, Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { MAX_GEO_RING } from './h3.service.js';
import type { CreateGeoBoundaryInput, GeoContainsInput } from './geo.service.js';
import { GeoService } from './geo.service.js';

class FarmsNearQuery {
  @IsNumber()
  lat!: number;

  @IsNumber()
  long!: number;

  @IsOptional()
  @IsIn([...H3_RESOLUTIONS])
  res?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_GEO_RING)
  ring?: number;
}

class ClustersQuery {
  @IsOptional()
  @IsIn([...H3_RESOLUTIONS])
  res?: number;
}

class ListBoundariesQuery {
  @IsOptional()
  @IsIn([...GEO_BOUNDARY_KINDS])
  kind?: (typeof GEO_BOUNDARY_KINDS)[number];
}

class CreateBoundaryDto implements CreateGeoBoundaryInput {
  @IsIn([...GEO_BOUNDARY_KINDS])
  kind!: CreateGeoBoundaryInput['kind'];

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  parentId?: string;

  /** Raw GeoJSON Polygon/MultiPolygon geometry; structurally validated. */
  @IsNotEmpty()
  boundaryGeojson!: unknown;
}

class ContainsDto implements GeoContainsInput {
  @IsNumber()
  lat!: number;

  @IsNumber()
  long!: number;

  /** Stored boundary to test against (xor geojson). */
  @ValidateIf((dto: ContainsDto) => dto.geojson === undefined)
  @IsString()
  boundaryId?: string;

  /** Inline GeoJSON Polygon/MultiPolygon geometry (xor boundaryId). */
  @ValidateIf((dto: ContainsDto) => dto.boundaryId === undefined)
  @IsNotEmpty()
  geojson?: unknown;
}

/**
 * Geospatial pack (Wave GEO). All spatial indexing is H3-based and computed
 * in the application layer — no PostGIS (migration 026 header + docs).
 */
@ApiTags('geo')
@Controller('geo')
@UseGuards(RolesGuard)
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  @Post('reindex')
  @Roles('admin')
  @ApiOperation({
    summary:
      'Rebuild the H3 index from source repositories (farm plots + located profiles). Idempotent; reports per-entity counts. Audit-logged.'
  })
  async reindex(@CurrentUser() actor: User | null) {
    return { data: await this.geo.reindex(actor) };
  }

  @Get('farms/near')
  @Authenticated()
  @ApiOperation({
    summary:
      'Farm plots inside the k-ring around the cell containing (lat, long). Managers see all plots; everyone else only their own.'
  })
  async farmsNear(@Query() query: FarmsNearQuery, @CurrentUser() actor: User | null) {
    return {
      data: await this.geo.farmsNear(actor, {
        lat: query.lat,
        long: query.long,
        res: query.res,
        ring: query.ring
      })
    };
  }

  @Get('farms/clusters')
  @Roles('admin', 'partner', 'chapter_lead')
  @ApiOperation({
    summary: 'Indexed-farm counts per H3 cell for cluster map rendering (managers only).'
  })
  async farmClusters(@Query() query: ClustersQuery, @CurrentUser() actor: User | null) {
    return { data: await this.geo.farmClusters(actor, query.res) };
  }

  @Get('boundaries')
  @Authenticated()
  @ApiOperation({ summary: 'List named boundaries (state/LGA/ward/custom).' })
  async listBoundaries(@Query() query: ListBoundariesQuery, @CurrentUser() actor: User | null) {
    return { data: await this.geo.listBoundaries(actor, query.kind) };
  }

  @Post('boundaries')
  @Roles('admin')
  @ApiOperation({ summary: 'Register a named boundary (admin). Audit-logged.' })
  async createBoundary(@Body() dto: CreateBoundaryDto, @CurrentUser() actor: User | null) {
    return { data: await this.geo.createBoundary(actor, dto) };
  }

  @Get('cells/:h3')
  @Authenticated()
  @ApiOperation({ summary: 'H3 cell boundary as closed GeoJSON Polygon for map rendering.' })
  async cellBoundary(@Param('h3') h3: string, @CurrentUser() actor: User | null) {
    return { data: this.geo.cellBoundary(actor, h3) };
  }

  @Post('contains')
  @Authenticated()
  @ApiOperation({
    summary:
      'Point-in-boundary check (ray casting over GeoJSON — no PostGIS). Used by livestock movement-permit zone checks.'
  })
  async contains(@Body() dto: ContainsDto, @CurrentUser() actor: User | null) {
    return { data: await this.geo.contains(actor, dto) };
  }
}
