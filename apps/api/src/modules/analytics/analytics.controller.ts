import { Controller, Get, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import type { Response } from 'express';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { AuditService } from '../../core/audit.service.js';
import { AnalyticsService } from './analytics.service.js';
import { analyticsExportCsv, analyticsExportPdf } from './export-formats.js';

class SegmentQuery {
  @IsIn(['state', 'role'])
  by!: 'state' | 'role';
}

class ExportQuery {
  @IsOptional()
  @IsIn(['json', 'csv', 'pdf'])
  format?: 'json' | 'csv' | 'pdf';
}

@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService
  ) {}

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
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Analytics export bundle. format=json (default) returns the JSON bundle; format=csv streams an RFC 4180 CSV; format=pdf returns a tabular PDF. Admin only; every export is audit-logged.'
  })
  async export(
    @Query() query: ExportQuery,
    @CurrentUser() actor: User | null,
    @Res({ passthrough: true }) response: Response
  ) {
    const format = query.format ?? 'json';
    const bundle = await this.analytics.export();
    await this.audit.record({
      actorId: actor?.id ?? 'unknown',
      action: 'analytics.export',
      entityType: 'analytics_export',
      entityId: format,
      metadata: { format, generatedAt: bundle.generatedAt }
    });
    if (format === 'csv') {
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.setHeader('Content-Disposition', 'attachment; filename="analytics-export.csv"');
      // overview is a named interface (no implicit index signature); spread to
      // satisfy the Record<string, number> formatter contract.
      return analyticsExportCsv({ ...bundle, overview: { ...bundle.overview } });
    }
    if (format === 'pdf') {
      const pdf = await analyticsExportPdf({ ...bundle, overview: { ...bundle.overview } });
      response.setHeader('Content-Type', 'application/pdf');
      response.setHeader('Content-Disposition', 'attachment; filename="analytics-export.pdf"');
      return new StreamableFile(pdf);
    }
    return { data: bundle };
  }
}
