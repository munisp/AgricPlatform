/**
 * Lender Lens scorecard export (Stage 27, innovation #20): parquet part-file
 * + JSON manifest written to S3-compatible object storage, delivered to the
 * partner as SigV4-presigned GET URLs.
 *
 * Fail-closed doctrine: the object-storage driver is the gate. When the
 * exporter is not configured (LAKEHOUSE_* env unset — i.e. the stub), the
 * endpoint answers 503 ServiceUnavailableException in EVERY environment and
 * never fabricates an export; the JSON scorecard endpoint keeps serving the
 * real stored payload from Postgres (honestly degraded).
 *
 * Object layout (under the lakehouse prefix):
 *   {prefix}/lender-scorecards/lender={partnerId}/period={YYYY-MM}/scorecard-{version}.parquet
 *   {prefix}/lender-scorecards/lender={partnerId}/period={YYYY-MM}/manifest-{version}.json
 * The manifest is the commit point (part file first, manifest second), same
 * as the lakehouse exporter.
 */
import { createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import {
  loadLakehouseConfig,
  lakehouseConfigIncomplete,
  type LakehouseConfig
} from './exporter/lakehouse.config.js';
import type { LakehouseS3 } from './exporter/lakehouse-exporter.service.js';
import { presignGetObject } from './exporter/s3-presign.js';
import { writeScorecardParquet } from './exporter/scorecard-parquet.js';
import {
  LenderScorecardService,
  type ScorecardEnvelope
} from './lender-scorecard.service.js';

/** Local DI tokens (shared token files stay untouched). */
export const LENDER_LENS_EXPORT_CONFIG = Symbol('LENDER_LENS_EXPORT_CONFIG');
export const LENDER_LENS_S3 = Symbol('LENDER_LENS_S3');

/** Presigned URL lifetime (seconds). */
export const SCORECARD_URL_TTL_SECONDS = 3600;

export interface ScorecardExportResult {
  version: string;
  period: string;
  payloadHash: string;
  /** sha256 of the parquet part-file bytes. */
  parquetSha256: string;
  url: string;
  manifestUrl: string;
  urlExpiresAt: string;
  /** Serve-time staleness badge (carried from the scorecard envelope). */
  stale: boolean;
}

interface ScorecardManifest {
  format: 'parquet';
  lenderPartnerId: string;
  version: string;
  period: string;
  payloadHash: string;
  generatedAt: string;
  exportedAt: string;
  files: { key: string; bytes: number; sha256: string }[];
}

@Injectable()
export class LenderScorecardExportService {
  constructor(
    private readonly scorecards: LenderScorecardService,
    @Inject(LENDER_LENS_EXPORT_CONFIG) private readonly config: LakehouseConfig,
    @Inject(LENDER_LENS_S3) private readonly s3: LakehouseS3 | null,
    private readonly telemetry: TelemetryService
  ) {}

  /** True only when a real object-storage driver is wired. */
  isEnabled(): boolean {
    return this.config.enabled && !lakehouseConfigIncomplete(this.config) && Boolean(this.s3);
  }

  /** Exports the scorecard and returns presigned download URLs. */
  async export(
    lenderPartnerId: string,
    period?: string,
    version?: string,
    context: { userId?: string; roles?: string[] } = {}
  ): Promise<ScorecardExportResult> {
    const envelope = await this.scorecards.scorecard(lenderPartnerId, period, version, context);
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException(
        'Scorecard export storage is not configured on this API (LAKEHOUSE_ENABLED / ' +
          'LAKEHOUSE_BUCKET / LAKEHOUSE_S3 credentials). The JSON scorecard endpoint ' +
          'remains available; no export is fabricated.'
      );
    }
    const s3 = this.s3 as LakehouseS3;
    const row = {
      id: '',
      lenderPartnerId,
      version: envelope.payload.version,
      period: envelope.payload.period,
      payload: envelope.payload,
      payloadHash: envelope.payloadHash,
      generatedAt: envelope.generatedAt
    };
    const part = await writeScorecardParquet(row);
    const parquetSha256 = createHash('sha256').update(part).digest('hex');
    const bucket = this.config.bucket as string;
    const base =
      `${this.config.prefix}/lender-scorecards/lender=${lenderPartnerId}` +
      `/period=${row.period}`;
    const partKey = `${base}/scorecard-${row.version}.parquet`;
    const manifestKey = `${base}/manifest-${row.version}.json`;

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: partKey,
        Body: part,
        ContentType: 'application/octet-stream'
      })
    );
    const manifest: ScorecardManifest = {
      format: 'parquet',
      lenderPartnerId,
      version: row.version,
      period: row.period,
      payloadHash: row.payloadHash,
      generatedAt: row.generatedAt,
      exportedAt: new Date().toISOString(),
      files: [{ key: partKey, bytes: part.length, sha256: parquetSha256 }]
    };
    // Commit point: the manifest flips only after the part file landed.
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: manifestKey,
        Body: JSON.stringify(manifest, null, 2),
        ContentType: 'application/json'
      })
    );

    const now = new Date();
    const sign = (key: string) =>
      presignGetObject({
        endpoint: this.config.endpoint ?? `https://s3.${this.config.region}.amazonaws.com`,
        region: this.config.region,
        bucket,
        key,
        accessKeyId: this.config.accessKeyId as string,
        secretAccessKey: this.config.secretAccessKey as string,
        expiresSeconds: SCORECARD_URL_TTL_SECONDS,
        now
      });
    this.telemetry.increment('analytics.scorecard_exports_total', 1, {
      'tenant.id': lenderPartnerId
    });
    return {
      version: row.version,
      period: row.period,
      payloadHash: row.payloadHash,
      parquetSha256,
      url: sign(partKey),
      manifestUrl: sign(manifestKey),
      urlExpiresAt: new Date(now.getTime() + SCORECARD_URL_TTL_SECONDS * 1000).toISOString(),
      stale: envelope.stale
    };
  }
}

/** Loads the exporter config (same LAKEHOUSE_* env contract as lakehouse). */
export function loadLenderLensExportConfig(env: NodeJS.ProcessEnv = process.env): LakehouseConfig {
  return loadLakehouseConfig(env);
}

export type { ScorecardEnvelope };
