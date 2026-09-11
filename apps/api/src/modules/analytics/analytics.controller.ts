import { BadRequestException, Controller, Get, Param, Post, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import type { Response } from 'express';
import type { User } from '@agric-platform/shared';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { AuditService } from '../../core/audit.service.js';
import { AnalyticsDepthService } from './analytics-depth.service.js';
import { AnalyticsService } from './analytics.service.js';
import { LakehouseExporterService } from './exporter/lakehouse-exporter.service.js';
import { analyticsExportCsv, analyticsExportPdf } from './export-formats.js';
import { MART_NAMES, type MartName } from './marts.js';
import { AnalyticsProjectorService } from './projector.service.js';
import { lagosDateKey } from './retention.js';
import { SEGMENT_DIMENSIONS, type SegmentDimension } from './segmentation.js';
import { AnalyticsStarService } from './star-marts.service.js';
import { STAR_FACT_NAMES, type StarFactName } from './star-marts.js';

class SegmentQuery {
  @IsIn(['state', 'role'])
  by!: 'state' | 'role';
}

class ExportQuery {
  @IsOptional()
  @IsIn(['json', 'csv', 'pdf'])
  format?: 'json' | 'csv' | 'pdf';
}

class SegmentationQuery {
  @IsIn(SEGMENT_DIMENSIONS)
  by!: SegmentDimension;
}

class FunnelQuery {
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(3650)
  windowDays?: number;
}

class RetentionQuery {
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(52)
  weeks?: number;
}

class MartSnapshotQuery {
  /** Lagos calendar day to snapshot; defaults to today (Africa/Lagos). */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;
}

class MartExportQuery {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;
}

function parseMart(raw: string): MartName {
  if (!(MART_NAMES as readonly string[]).includes(raw)) {
    throw new BadRequestException(
      `Unknown mart '${raw}'; expected one of ${MART_NAMES.join(', ')}`
    );
  }
  return raw as MartName;
}

@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly depth: AnalyticsDepthService,
    private readonly audit: AuditService,
    private readonly projector: AnalyticsProjectorService,
    private readonly star: AnalyticsStarService,
    private readonly lakehouse: LakehouseExporterService
  ) {}

  @Get('metrics')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Platform metrics (admin only — consistent with the export/funnel routes)' })
  async metrics() {
    return { data: await this.analytics.metrics() };
  }

  @Get('overview')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Live cross-domain counts (admin only)' })
  async overview() {
    return { data: await this.analytics.overview() };
  }

  @Get('segments')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Member segmentation by state or role (admin only)' })
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

  // -- Wave lakehouse-export: marts → object storage (parquet + manifest) ------

  @Post('export')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Lakehouse export run: writes every analytics star mart (migration 019) to S3-compatible object storage as Parquet part-files under hive-style dt=YYYY-MM-DD/ partitions, plus a _manifest.json (row counts, part files, SHA-256 per file). Idempotent per run date — re-running replaces the day partition. Requires LAKEHOUSE_ENABLED=true with bucket/credentials, otherwise 503. Admin only; audit-logged.'
  })
  async exportLakehouse(@CurrentUser() actor: User | null) {
    const manifest = await this.lakehouse.runExport();
    await this.audit.record({
      actorId: actor?.id ?? 'unknown',
      action: 'analytics.export.lakehouse',
      entityType: 'lakehouse_export',
      entityId: manifest.runId,
      metadata: {
        runDate: manifest.runDate,
        totalRows: manifest.totalRows,
        totalBytes: manifest.totalBytes
      }
    });
    return { data: manifest };
  }

  @Get('export/last')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Last lakehouse export status: { enabled, manifest }. manifest is the _manifest.json of the most recent run (object storage is the source of truth; no new database table exists) or null before the first run. When LAKEHOUSE_ENABLED=false, enabled=false with a reason. Admin only.'
  })
  async lakehouseExportLast() {
    return { data: await this.lakehouse.lastExportStatus() };
  }

  // -- M13 analytics depth (Wave P5c) -------------------------------------------

  @Get('segmentation')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Member segmentation by state, crop, role, KYC tier or signup cohort, with counts and percentages of the member population. Admin only.'
  })
  async segmentation(@Query() query: SegmentationQuery) {
    return { data: await this.depth.segment(query.by) };
  }

  @Get('funnel')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Member funnel registration → profile-complete → first-course → first-application over the trailing windowDays (default 90). Admin only.'
  })
  async funnel(@Query() query: FunnelQuery) {
    return { data: await this.depth.funnel(query.windowDays) };
  }

  @Get('funnel/chapters')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Chapter-ops funnel: events → RSVPs → attendance. Admin only.'
  })
  async chapterFunnel() {
    return { data: await this.depth.chapterFunnel() };
  }

  @Get('retention')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Weekly signup → active cohort retention matrix (Africa/Lagos, Monday week start; current week is partial). Admin only.'
  })
  async retention(@Query() query: RetentionQuery) {
    return { data: await this.depth.retention(query.weeks) };
  }

  @Post('marts/snapshot')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'ETL snapshot job: recomputes all KPI marts for one Lagos calendar day (default today) and upserts them — idempotent per date, safe to re-run for backfills. Admin only; audit-logged.'
  })
  async snapshotMarts(@Query() query: MartSnapshotQuery, @CurrentUser() actor: User | null) {
    const date = query.date ?? lagosDateKey(new Date());
    const snapshot = await this.depth.snapshotMarts(date);
    await this.audit.record({
      actorId: actor?.id ?? 'unknown',
      action: 'analytics.marts.snapshot',
      entityType: 'analytics_mart',
      entityId: date,
      metadata: { date }
    });
    return { data: snapshot };
  }

  @Get('marts/:mart/export')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary: 'Lakehouse handoff: columnar-friendly CSV (parquet-ready schema; snapshot_date partition column) for one mart over an optional date range. Admin only; audit-logged.'
  })
  async exportMart(
    @Param('mart') martParam: string,
    @Query() query: MartExportQuery,
    @CurrentUser() actor: User | null,
    @Res({ passthrough: true }) response: Response
  ) {
    const mart = parseMart(martParam);
    const csv = await this.depth.martCsv(mart, { from: query.from, to: query.to });
    await this.audit.record({
      actorId: actor?.id ?? 'unknown',
      action: 'analytics.marts.export',
      entityType: 'analytics_mart',
      entityId: mart,
      metadata: { mart, from: query.from, to: query.to }
    });
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="mart-${mart.replace(/_/g, '-')}.csv"`
    );
    return csv;
  }

  // -- Wave B: star-schema marts (analytics schema, migration 019) -----------

  @Post('project')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({
    summary:
      'Runs one outbox→mart projection pass: applies unprocessed domain events to the analytics star marts (idempotent upserts; replay-safe) and recomputes the daily rollups for touched Lagos days. No in-process timer exists — an external scheduler (cron/CronJob) calls this endpoint. Admin only; audit-logged.'
  })
  async project(@CurrentUser() actor: User | null) {
    const result = await this.projector.project();
    await this.audit.record({
      actorId: actor?.id ?? 'unknown',
      action: 'analytics.project',
      entityType: 'analytics_projection',
      entityId: result.ranAt,
      metadata: {
        scanned: result.scanned,
        applied: result.applied,
        skipped: result.skipped,
        recomputedDates: result.recomputedDates
      }
    });
    return { data: result };
  }

  @Get('metrics/daily')
  @UseGuards(RolesGuard)
  @Roles('admin', 'regulator')
  @ApiOperation({
    summary:
      'Daily rollup mart (mart_daily_metrics) over an inclusive YYYY-MM-DD range: GMV (kobo), orders, active farmers, escrow held, livestock registered — Africa/Lagos calendar days. Admin or regulator.'
  })
  async dailyMetrics(@Query() query: MartExportQuery) {
    return { data: await this.star.dailyMetrics({ from: query.from, to: query.to }) };
  }

  @Get('metrics/summary')
  @UseGuards(RolesGuard)
  @Roles('admin', 'regulator')
  @ApiOperation({
    summary:
      'Headline star-mart numbers: GMV (kobo, non-cancelled orders), orders, current escrow exposure (kobo), livestock registered, member/listing dimensions and the projector heartbeat. Admin or regulator.'
  })
  async metricsSummary() {
    return { data: await this.star.summary() };
  }

  @Get('export/:fact.csv')
  @UseGuards(RolesGuard)
  @Roles('admin', 'regulator')
  @ApiOperation({
    summary:
      'Lakehouse handoff: streaming CSV of a star fact table (fact_orders, fact_payments) over an optional date range, columns mirroring migration 019 1:1. When a real lakehouse exists (object storage + Iceberg + Trino), these exports are its ingestion contract. Admin or regulator; audit-logged.'
  })
  async exportFact(
    @Param('fact') factParam: string,
    @Query() query: MartExportQuery,
    @CurrentUser() actor: User | null,
    @Res({ passthrough: true }) response: Response
  ) {
    if (!(STAR_FACT_NAMES as readonly string[]).includes(factParam)) {
      throw new BadRequestException(
        `Unknown fact '${factParam}'; expected one of ${STAR_FACT_NAMES.join(', ')}`
      );
    }
    const fact = factParam as StarFactName;
    const csv = await this.star.factCsv(fact, { from: query.from, to: query.to });
    await this.audit.record({
      actorId: actor?.id ?? 'unknown',
      action: 'analytics.export.fact',
      entityType: 'analytics_fact',
      entityId: fact,
      metadata: { fact, from: query.from, to: query.to }
    });
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${fact}.csv"`);
    return csv;
  }
}
