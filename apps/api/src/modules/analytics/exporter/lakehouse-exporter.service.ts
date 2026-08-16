/**
 * LakehouseExporterService (Wave lakehouse-export).
 *
 * Exports every analytics star mart (migration 019) to S3-compatible object
 * storage as Parquet part-files in hive-style partitions:
 *
 *   s3://{bucket}/{prefix}/{table}/dt=YYYY-MM-DD/part-{runId}-00000.parquet
 *   s3://{bucket}/{prefix}/_manifests/dt=YYYY-MM-DD/{runId}.json
 *   s3://{bucket}/{prefix}/_manifest.json          (latest-run pointer)
 *
 * Run semantics: one run = one Lagos calendar day partition per table.
 * Re-running the same day REPLACES that partition: the new run's part files
 * and manifest are written first (manifest flip is the commit point), then
 * part files from superseded runs of the same day are deleted. There is no
 * table-format catalog (Iceberg/Delta) — the `_manifest.json` files are the
 * contract, documented in docs/analytics-lakehouse.md.
 *
 * Last-manifest persistence: object storage is the source of truth
 * (`_manifest.json`); the service keeps an in-memory copy as a fast path for
 * GET /analytics/export/last. No new database table exists (the migration
 * budget for this wave is zero) — after an API restart the status endpoint
 * re-reads the pointer object from storage.
 *
 * Fail-closed: LAKEHOUSE_ENABLED=true with a missing bucket or credentials
 * aborts Nest module init in production; in non-production the exporter
 * degrades to disabled with a warning. Credentials are read from the
 * environment only and never logged (the manifest carries bucket/prefix/keys,
 * never secrets).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { isProduction } from '../../../common/auth/auth.config.js';
import { ANALYTICS_STAR_REPOSITORY } from '../../../database/persistence.tokens.js';
import type { AnalyticsStarRepository } from '../../../database/repositories/analytics-star.repository.js';
import { lagosDateKey } from '../retention.js';
import {
  LAKEHOUSE_CONFIG,
  lakehouseConfigIncomplete,
  type LakehouseConfig
} from './lakehouse.config.js';
import {
  LAKEHOUSE_TABLES,
  writeParquetPart,
  type LakehouseTable
} from './lakehouse-parquet.js';

export const LAKEHOUSE_S3 = Symbol('LAKEHOUSE_S3');

/** Narrow S3 surface so unit tests can inject a fake without the SDK client. */
export interface LakehouseS3 {
  send(command: unknown): Promise<unknown>;
}

/** Wrap a real SDK client into the narrow surface. */
export function wrapS3Client(client: S3Client): LakehouseS3 {
  return { send: (command) => client.send(command as never) as Promise<unknown> };
}

export interface LakehousePartFile {
  key: string;
  bytes: number;
  /** Lower-case hex SHA-256 of the part-file bytes. */
  sha256: string;
}

export interface LakehouseTableExport {
  table: LakehouseTable;
  rows: number;
  files: LakehousePartFile[];
}

export interface LakehouseManifest {
  runId: string;
  /** Lagos calendar day — the dt= partition value for every table. */
  runDate: string;
  bucket: string;
  prefix: string;
  format: 'parquet';
  startedAt: string;
  finishedAt: string;
  tables: LakehouseTableExport[];
  totalRows: number;
  totalBytes: number;
}

/** Response contract of GET /analytics/export/last. */
export interface LakehouseExportStatus {
  enabled: boolean;
  /** Present when enabled=false: why the exporter is off. */
  reason?: string;
  bucket?: string;
  prefix: string;
  manifest: LakehouseManifest | null;
}

@Injectable()
export class LakehouseExporterService {
  private readonly logger = new Logger(LakehouseExporterService.name);
  /** Set by onModuleInit when enabled-but-misconfigured outside production. */
  private degradedReason?: string;
  private lastManifest: LakehouseManifest | null = null;

  constructor(
    @Inject(ANALYTICS_STAR_REPOSITORY) private readonly star: AnalyticsStarRepository,
    @Inject(LAKEHOUSE_CONFIG) private readonly config: LakehouseConfig,
    @Inject(LAKEHOUSE_S3) private readonly s3: LakehouseS3 | null
  ) {}

  /** Fail-closed init: enabled + incomplete config must not silently disable in production. */
  onModuleInit(): void {
    if (!this.config.enabled) return;
    if (lakehouseConfigIncomplete(this.config) || !this.s3) {
      const message =
        'LAKEHOUSE_ENABLED=true but LAKEHOUSE_BUCKET and/or LAKEHOUSE_S3_ACCESS_KEY / ' +
        'LAKEHOUSE_S3_SECRET_KEY are missing.';
      if (isProduction({ NODE_ENV: this.config.nodeEnv } as NodeJS.ProcessEnv)) {
        throw new Error(`Refusing to start: ${message} (fail-closed)`);
      }
      this.degradedReason = `${message} Exporter disabled for this process (non-production).`;
      this.logger.warn(this.degradedReason);
    }
  }

  isEnabled(): boolean {
    return this.config.enabled && !this.degradedReason && Boolean(this.s3);
  }

  /** Run one export over all mart tables; returns the persisted manifest. */
  async runExport(now: Date = new Date()): Promise<LakehouseManifest> {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException(
        this.degradedReason ??
          'Lakehouse export is disabled. Set LAKEHOUSE_ENABLED=true with LAKEHOUSE_BUCKET, ' +
            'LAKEHOUSE_S3_ENDPOINT and LAKEHOUSE_S3_ACCESS_KEY/SECRET_KEY to enable it.'
      );
    }
    const s3 = this.s3 as LakehouseS3;
    const runId = randomUUID();
    const runDate = lagosDateKey(now);
    const startedAt = now.toISOString();
    const bucket = this.config.bucket as string;
    const tables: LakehouseTableExport[] = [];

    for (const table of LAKEHOUSE_TABLES) {
      const rows = await this.readTable(table);
      const part = await writeParquetPart(table, rows);
      const key = `${this.config.prefix}/${table}/dt=${runDate}/part-${runId}-00000.parquet`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: part,
          ContentType: 'application/octet-stream'
        })
      );
      tables.push({
        table,
        rows: rows.length,
        files: [
          { key, bytes: part.length, sha256: createHash('sha256').update(part).digest('hex') }
        ]
      });
    }

    const manifest: LakehouseManifest = {
      runId,
      runDate,
      bucket,
      prefix: this.config.prefix,
      format: 'parquet',
      startedAt,
      finishedAt: new Date().toISOString(),
      tables,
      totalRows: tables.reduce((sum, t) => sum + t.rows, 0),
      totalBytes: tables.reduce((sum, t) => sum + t.files.reduce((s, f) => s + f.bytes, 0), 0)
    };

    // Commit point: the run manifest, then the latest-run pointer flip. Only
    // after both land do we delete superseded part files (idempotent re-run
    // of the same dt= partition replaces it).
    const body = JSON.stringify(manifest, null, 2);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: this.runManifestKey(runDate, runId),
        Body: body,
        ContentType: 'application/json'
      })
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: this.latestManifestKey(),
        Body: body,
        ContentType: 'application/json'
      })
    );
    await this.deleteSupersededParts(s3, bucket, manifest);
    this.lastManifest = manifest;
    this.logger.log(
      `Lakehouse export ${runId} (${runDate}): ${manifest.totalRows} rows, ` +
        `${manifest.totalBytes} bytes across ${tables.length} tables.`
    );
    return manifest;
  }

  /**
   * Status for GET /analytics/export/last: honest disabled state, otherwise
   * the last manifest from memory or (after a restart) from object storage.
   */
  async lastExportStatus(): Promise<LakehouseExportStatus> {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        reason:
          this.degradedReason ??
          'LAKEHOUSE_ENABLED is not true — the lakehouse exporter is disabled on this API.',
        prefix: this.config.prefix,
        manifest: null
      };
    }
    if (this.lastManifest) {
      return this.status(this.lastManifest);
    }
    const manifest = await this.readLatestManifest();
    this.lastManifest = manifest;
    return this.status(manifest);
  }

  private status(manifest: LakehouseManifest | null): LakehouseExportStatus {
    return {
      enabled: true,
      bucket: this.config.bucket,
      prefix: this.config.prefix,
      manifest
    };
  }

  private latestManifestKey(): string {
    return `${this.config.prefix}/_manifest.json`;
  }

  private runManifestKey(runDate: string, runId: string): string {
    return `${this.config.prefix}/_manifests/dt=${runDate}/${runId}.json`;
  }

  private async readLatestManifest(): Promise<LakehouseManifest | null> {
    try {
      const output = (await (this.s3 as LakehouseS3).send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: this.latestManifestKey() })
      )) as { Body?: { transformToString(): Promise<string> } };
      const text = await output.Body?.transformToString();
      return text ? (JSON.parse(text) as LakehouseManifest) : null;
    } catch (error) {
      const name = (error as { name?: string }).name ?? '';
      if (name === 'NoSuchKey' || name === 'NotFound' || name === 'NoSuchBucket') {
        return null; // first run has not happened yet — honest empty state
      }
      throw error; // storage unreachable: surface the failure, never fake a status
    }
  }

  /** Delete part files of the same dt= partition written by earlier runs. */
  private async deleteSupersededParts(
    s3: LakehouseS3,
    bucket: string,
    manifest: LakehouseManifest
  ): Promise<void> {
    const current = new Set(manifest.tables.flatMap((t) => t.files.map((f) => f.key)));
    for (const table of manifest.tables) {
      const prefix = `${this.config.prefix}/${table.table}/dt=${manifest.runDate}/`;
      const listed = (await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix })
      )) as { Contents?: { Key?: string }[] };
      for (const object of listed.Contents ?? []) {
        const key = object.Key;
        if (key && key.endsWith('.parquet') && !current.has(key)) {
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        }
      }
    }
  }

  private async readTable(table: LakehouseTable): Promise<unknown[]> {
    switch (table) {
      case 'dim_users':
        return this.star.dimUsers();
      case 'dim_listings':
        return this.star.dimListings();
      case 'fact_orders':
        return this.star.factOrders();
      case 'fact_payments':
        return this.star.factPayments();
      case 'fact_livestock':
        return this.star.factLivestock();
      case 'mart_daily_metrics':
        return this.star.dailyMetrics();
    }
  }
}
