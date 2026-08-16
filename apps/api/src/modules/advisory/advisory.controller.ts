import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { AdvisoryItem, User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { ListQueryDto } from '../../common/pagination.js';
import { AdvisoryService, type CreateAdvisoryInput } from './advisory.service.js';

const ADVISORY_KINDS = ['crop_calendar', 'pest_alert', 'weather', 'price', 'guide'] as const;

class ListAdvisoryQuery extends ListQueryDto {
  @IsOptional()
  @IsIn(ADVISORY_KINDS)
  kind?: AdvisoryItem['kind'];

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  crop?: string;
}

class CreateAdvisoryDto implements CreateAdvisoryInput {
  @IsIn(ADVISORY_KINDS)
  kind!: AdvisoryItem['kind'];

  @IsString()
  title!: string;

  @IsString()
  summary!: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  crop?: string;

  @IsOptional()
  @IsIn(['info', 'warning', 'critical'])
  severity?: AdvisoryItem['severity'];
}

@ApiTags('advisory')
@Controller('advisory')
export class AdvisoryController {
  constructor(private readonly advisory: AdvisoryService) {}

  @Get()
  @ApiOperation({ summary: 'List advisory content (crop calendar, pest alerts, guides)' })
  list(@Query() query: ListAdvisoryQuery) {
    return this.advisory.list(query);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin', 'agronomist', 'partner')
  @ApiOperation({ summary: 'Publish advisory content (admin/agronomist/partner only)' })
  async create(@Body() dto: CreateAdvisoryDto, @CurrentUser() actor: User | null) {
    return { data: await this.advisory.create(dto, actor?.id ?? 'anonymous') };
  }

  @Get('weather/:state')
  @ApiOperation({ summary: 'Weather readiness snapshot for a state (provider adapter)' })
  async weather(@Param('state') state: string) {
    return { data: await this.advisory.weatherFor(state) };
  }

  @Get('prices/:crop')
  @ApiOperation({ summary: 'Price signal for a crop (provider adapter)' })
  async price(@Param('crop') crop: string, @Query('state') state?: string) {
    return { data: await this.advisory.priceFor(crop, state) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Advisory item detail' })
  async get(@Param('id') id: string) {
    return { data: await this.advisory.get(id) };
  }
}
