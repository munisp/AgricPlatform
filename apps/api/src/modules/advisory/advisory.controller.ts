import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { AdvisoryItem } from '@agric-platform/shared';
import { ActorId } from '../../common/auth/current-user.decorator.js';
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
  @ApiOperation({ summary: 'Publish advisory content' })
  create(@Body() dto: CreateAdvisoryDto, @ActorId() actorId: string) {
    return { data: this.advisory.create(dto, actorId) };
  }

  @Get('weather/:state')
  @ApiOperation({ summary: 'Weather readiness snapshot for a state (provider adapter)' })
  weather(@Param('state') state: string) {
    return { data: this.advisory.weatherFor(state) };
  }

  @Get('prices/:crop')
  @ApiOperation({ summary: 'Price signal for a crop (provider adapter)' })
  price(@Param('crop') crop: string, @Query('state') state?: string) {
    return { data: this.advisory.priceFor(crop, state) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Advisory item detail' })
  get(@Param('id') id: string) {
    return { data: this.advisory.get(id) };
  }
}
