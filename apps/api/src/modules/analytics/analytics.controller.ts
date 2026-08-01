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
  metrics() {
    return { data: this.analytics.metrics() };
  }

  @Get('overview')
  @ApiOperation({ summary: 'Live cross-domain counts' })
  overview() {
    return { data: this.analytics.overview() };
  }

  @Get('segments')
  @ApiOperation({ summary: 'Member segmentation by state or role' })
  segments(@Query() query: SegmentQuery) {
    return { data: this.analytics.segments(query.by) };
  }

  @Get('export')
  @ApiOperation({ summary: 'Analytics export bundle (JSON)' })
  export() {
    return { data: this.analytics.export() };
  }
}
