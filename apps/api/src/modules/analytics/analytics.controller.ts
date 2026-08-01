import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { AnalyticsService } from './analytics.service.js';

class SegmentQuery {
  @IsIn(['state', 'role'])
  by!: 'state' | 'role';
}

@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('metrics')
  @ApiOperation({ summary: 'Platform metrics' })
  async metrics() {
    return { data: await this.analytics.metrics() };
  }

  @Get('overview')
  @ApiOperation({ summary: 'Live cross-domain counts' })
  async overview() {
    return { data: await this.analytics.overview() };
  }

  @Get('segments')
  @ApiOperation({ summary: 'Member segmentation by state or role' })
  async segments(@Query() query: SegmentQuery) {
    return { data: await this.analytics.segments(query.by) };
  }

  @Get('export')
  @ApiOperation({ summary: 'Analytics export bundle (JSON)' })
  async export() {
    return { data: await this.analytics.export() };
  }
}
