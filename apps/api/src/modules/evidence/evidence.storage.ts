import { createHash, createHmac } from 'node:crypto';
import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { ServiceUnavailableException } from '@nestjs/common';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';

/**
 * Evidence Locker object-storage driver (Stage 27 Innovation 13).
 *
 * Blobs live in S3-compatible object storage — the same driver path the
 * analytics lakehouse parquet exporter uses (@aws-sdk/client-s3, MinIO-
 * compatible endpoint override). Postgres stores references, never blobs.
 *
 * Uploads are PRESIGNED (SigV4 query-string auth, path-style URLs so the
 * same driver works against AWS and MinIO): the API never buffers evidence
 * bytes. The presign pins `x-amz-meta-sha256` as a SIGNED header carrying
 * the client-declared content hash, so confirm can re-read the hash from
 * object metadata (HeadObject) and refuse to record a row whose blob bytes
 * cannot be proven to match the declared sha256.
 *
 * Fail-closed (platform doctrine): the STUB driver is the default and every
 * operation answers 503 — a storage-less API must never fabricate
 * provenance with metadata-without-blob rows. The S3 driver requires
 * EVIDENCE_S3_BUCKET + credentials and throws ProviderConfigError at boot
 * when selected without them. No credentials are ever logged or returned.
 */

/** Line feed without a backslash literal (repo hazard rule). */
const LF = String.fromCharCode(10);

export interface PresignedEvidenceUrl {
  url: string;
  method: 'PUT' | 'GET';
  /** Signed headers the client MUST send verbatim (upload only). */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface EvidenceObjectStat {
  sizeBytes: number;
  /** sha256 pinned at upload (x-amz-meta-sha256); null = unverifiable. */
  sha256: string | null;
}

export interface EvidenceStorageDriver {
  readonly name: 'stub' | 's3';
  presignUpload(input: {
    objectKey: string;
    mime: string;
    sizeBytes: number;
    sha256: string;
  }): Promise<PresignedEvidenceUrl>;
  /** null when the object does not exist. Errors (unreachable) propagate. */
  stat(objectKey: string): Promise<EvidenceObjectStat | null>;
  presignDownload(objectKey: string): Promise<PresignedEvidenceUrl>;
  remove(objectKey: string): Promise<void>;
  /**
   * L-20 readiness probe for /health/ready. Stub reports configured:false
   * (fail-closed doctrine: never 'down'); the s3 driver probes bucket
   * reachability and reports healthy:false with failure evidence only.
   */
  healthCheck(): Promise<{ configured: boolean; healthy: boolean; detail: string }>;
}

export const EVIDENCE_STORAGE_DRIVER = Symbol('EVIDENCE_STORAGE_DRIVER');

/** Default presign lifetime; capped so URLs cannot be minted long-lived. */
export const EVIDENCE_PRESIGN_DEFAULT_TTL_SECONDS = 900;
export const EVIDENCE_PRESIGN_MAX_TTL_SECONDS = 3600;

const STORAGE_UNAVAILABLE =
  'Evidence storage is not configured (EVIDENCE_STORAGE_DRIVER=stub). ' +
  'No evidence row was or will be created without a stored blob.';

/** Default driver: deterministic, fabricates nothing, fails closed. */
export class StubEvidenceStorageDriver implements EvidenceStorageDriver {
  readonly name = 'stub' as const;

  presignUpload(): Promise<PresignedEvidenceUrl> {
    return Promise.reject(new ServiceUnavailableException(STORAGE_UNAVAILABLE));
  }
  stat(): Promise<EvidenceObjectStat | null> {
    return Promise.reject(new ServiceUnavailableException(STORAGE_UNAVAILABLE));
  }
  presignDownload(): Promise<PresignedEvidenceUrl> {
    return Promise.reject(new ServiceUnavailableException(STORAGE_UNAVAILABLE));
  }
  remove(): Promise<void> {
    return Promise.reject(new ServiceUnavailableException(STORAGE_UNAVAILABLE));
  }

  healthCheck(): Promise<{ configured: boolean; healthy: boolean; detail: string }> {
    return Promise.resolve({
      configured: false,
      healthy: true,
      detail: 'stub driver — evidence storage not configured (uploads fail closed with 503)'
    });
  }
}

// ---------------------------------------------------------------------------
// SigV4 query-string presigning (pure, known-answer testable)
// ---------------------------------------------------------------------------

export interface SigV4PresignInput {
  method: 'PUT' | 'GET';
  /** e.g. https://s3.us-east-1.amazonaws.com or http://localhost:9000. */
  endpoint: string;
  region: string;
  bucket: string;
  objectKey: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresInSeconds: number;
  /** Signing instant; injected for deterministic tests. */
  now: Date;
  /** Extra headers folded into the signature (e.g. x-amz-meta-sha256). */
  extraSignedHeaders?: Record<string, string>;
}

/** RFC 3986 encoding (encodeURIComponent leaves !'()* unescaped). */
function sigV4Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString(); // 2013-05-24T00:00:00.000Z
  const compact = iso.replace(/[-:]/g, '').replace(/[.]000Z$/, 'Z');
  return { amzDate: compact, dateStamp: compact.slice(0, 8) };
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * SigV4 presign (path-style). Reproduces the AWS reference implementation
 * known-answer vectors (botocore S3SigV4QueryAuth, frozen clock
 * 2013-05-24T00:00:00Z, documented example credentials); see
 * evidence.storage.spec.ts.
 */
export function presignS3Url(input: SigV4PresignInput): string {
  const endpoint = input.endpoint.replace(/[/]+$/, '');
  const host = new URL(endpoint).host;
  const { amzDate, dateStamp } = amzDates(input.now);
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;

  const signedHeaderMap: Record<string, string> = {
    host,
    ...(input.extraSignedHeaders ?? {})
  };
  const headerNames = Object.keys(signedHeaderMap)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders =
    headerNames
      .map((name) => `${name}:${signedHeaderMap[name] ?? ''}`)
      .join(LF) + LF;
  const signedHeaders = headerNames.join(';');

  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaders
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((key) => `${sigV4Encode(key)}=${sigV4Encode(query[key])}`)
    .join('&');

  const canonicalUri =
    '/' +
    [input.bucket, ...input.objectKey.split('/')]
      .map((segment) => sigV4Encode(segment))
      .join('/');

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD'
  ].join(LF);

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')
  ].join(LF);

  const kDate = hmac('AWS4' + input.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return `${endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ---------------------------------------------------------------------------
// Live S3-compatible driver
// ---------------------------------------------------------------------------

export interface EvidenceS3Config {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  presignTtlSeconds: number;
}

/** Parses env; throws ProviderConfigError when s3 is selected unconfigured. */
export function loadEvidenceS3Config(env: NodeJS.ProcessEnv): EvidenceS3Config {
  const bucket = env.EVIDENCE_S3_BUCKET?.trim() ?? '';
  const accessKeyId = env.EVIDENCE_S3_ACCESS_KEY?.trim() ?? '';
  const secretAccessKey = env.EVIDENCE_S3_SECRET_KEY?.trim() ?? '';
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new ProviderConfigError('evidence-s3', [
      ...(!bucket ? ['EVIDENCE_S3_BUCKET'] : []),
      ...(!accessKeyId ? ['EVIDENCE_S3_ACCESS_KEY'] : []),
      ...(!secretAccessKey ? ['EVIDENCE_S3_SECRET_KEY'] : [])
    ]);
  }
  const region = env.EVIDENCE_S3_REGION?.trim() || 'us-east-1';
  const endpoint =
    env.EVIDENCE_S3_ENDPOINT?.trim() || `https://s3.${region}.amazonaws.com`;
  const rawTtl = Number(env.EVIDENCE_PRESIGN_TTL_SECONDS ?? '');
  const presignTtlSeconds =
    Number.isFinite(rawTtl) && rawTtl > 0
      ? Math.min(Math.floor(rawTtl), EVIDENCE_PRESIGN_MAX_TTL_SECONDS)
      : EVIDENCE_PRESIGN_DEFAULT_TTL_SECONDS;
  return { bucket, endpoint, region, accessKeyId, secretAccessKey, presignTtlSeconds };
}

/** Narrow client surface so unit tests can inject a fake (lakehouse pattern). */
export interface EvidenceS3Client {
  send(command: unknown): Promise<unknown>;
}

export class S3EvidenceStorageDriver implements EvidenceStorageDriver {
  readonly name = 's3' as const;

  constructor(
    private readonly config: EvidenceS3Config,
    private readonly client: EvidenceS3Client,
    private readonly telemetry: TelemetryService = new TelemetryService()
  ) {}

  presignUpload(input: {
    objectKey: string;
    mime: string;
    sizeBytes: number;
    sha256: string;
  }): Promise<PresignedEvidenceUrl> {
    // Pin the declared content hash as a signed metadata header: the object
    // cannot land without it, and confirm re-reads it via HeadObject.
    // V-73: Content-Length is folded into the signature too, so the client
    // can only PUT exactly the declared byte count — the presign itself
    // enforces the service-side size ceiling, not just confirm.
    const url = presignS3Url({
      method: 'PUT',
      endpoint: this.config.endpoint,
      region: this.config.region,
      bucket: this.config.bucket,
      objectKey: input.objectKey,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      expiresInSeconds: this.config.presignTtlSeconds,
      now: new Date(),
      extraSignedHeaders: {
        'content-length': String(input.sizeBytes),
        'x-amz-meta-sha256': input.sha256
      }
    });
    return Promise.resolve({
      url,
      method: 'PUT',
      headers: {
        'Content-Type': input.mime,
        'Content-Length': String(input.sizeBytes),
        'x-amz-meta-sha256': input.sha256
      },
      expiresAt: new Date(Date.now() + this.config.presignTtlSeconds * 1000).toISOString()
    });
  }

  async stat(objectKey: string): Promise<EvidenceObjectStat | null> {
    return this.telemetry.withSpan('evidence.storage.stat', { 'evidence.storage': 's3' }, async () => {
      try {
        const out = (await this.client.send(
          new HeadObjectCommand({ Bucket: this.config.bucket, Key: objectKey })
        )) as { ContentLength?: number; Metadata?: Record<string, string> };
        return {
          sizeBytes: Number(out.ContentLength ?? 0),
          sha256: out.Metadata?.sha256 ?? null
        };
      } catch (error) {
        const name = (error as { name?: string }).name ?? '';
        if (name === 'NotFound' || name === 'NoSuchKey' || name === 'NoSuchBucket') {
          return null; // honest absence
        }
        throw error; // storage unreachable: surface, never fake a stat
      }
    });
  }

  presignDownload(objectKey: string): Promise<PresignedEvidenceUrl> {
    const url = presignS3Url({
      method: 'GET',
      endpoint: this.config.endpoint,
      region: this.config.region,
      bucket: this.config.bucket,
      objectKey,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      expiresInSeconds: this.config.presignTtlSeconds,
      now: new Date()
    });
    return Promise.resolve({
      url,
      method: 'GET',
      headers: {},
      expiresAt: new Date(Date.now() + this.config.presignTtlSeconds * 1000).toISOString()
    });
  }

  async remove(objectKey: string): Promise<void> {
    await this.telemetry.withSpan('evidence.storage.remove', { 'evidence.storage': 's3' }, async () => {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: objectKey })
      );
    });
  }

  /**
   * L-20 readiness probe: a HeadBucket round-trip proves the endpoint,
   * credentials and bucket are all usable (HeadObject would treat a missing
   * bucket as honest absence, so the bucket-level probe is used). Never
   * throws — probes must not break /health/ready.
   */
  async healthCheck(): Promise<{ configured: boolean; healthy: boolean; detail: string }> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
      return {
        configured: true,
        healthy: true,
        detail: `s3 bucket '${this.config.bucket}' reachable at ${this.config.endpoint}`
      };
    } catch (error) {
      return {
        configured: true,
        healthy: false,
        detail: `s3 bucket '${this.config.bucket}' probe failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      };
    }
  }
}

/**
 * Driver factory (fail-closed driver doctrine): stub by default; 's3'
 * requires full env config or throws ProviderConfigError at boot. Unknown
 * driver names are a config error, never a silent stub.
 */
export function createEvidenceStorageDriver(
  env: NodeJS.ProcessEnv = process.env,
  telemetry?: TelemetryService
): EvidenceStorageDriver {
  const name = (env.EVIDENCE_STORAGE_DRIVER ?? 'stub').trim().toLowerCase();
  if (name === 'stub') {
    return new StubEvidenceStorageDriver();
  }
  if (name === 's3') {
    const config = loadEvidenceS3Config(env);
    const client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      }
    });
    return new S3EvidenceStorageDriver(
      config,
      { send: (command) => client.send(command as never) as Promise<unknown> },
      telemetry
    );
  }
  throw new ProviderConfigError('evidence-storage', [
    `EVIDENCE_STORAGE_DRIVER (got '${name}', expected 'stub' or 's3'; fail-closed)`
  ]);
}
