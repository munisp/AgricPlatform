/**
 * Lakehouse exporter configuration (Wave lakehouse-export).
 *
 * The exporter ships the analytics star marts (migration 019) to S3-compatible
 * object storage as Parquet part-files in hive-style `dt=YYYY-MM-DD/`
 * partitions. It is OFF by default (LAKEHOUSE_ENABLED=false) and fails closed
 * when misconfigured: with LAKEHOUSE_ENABLED=true in production, a missing
 * bucket or credentials aborts module init instead of silently disabling.
 *
 * Credentials come from the environment ONLY and are never logged or
 * serialised — `redactLakehouseConfig` is the only shape that may leave the
 * process (logs, API responses).
 */

/** DI token (kept local to the exporter so shared token files stay untouched). */
export const LAKEHOUSE_CONFIG = Symbol('LAKEHOUSE_CONFIG');

export interface LakehouseConfig {
  /** LAKEHOUSE_ENABLED=true switches the exporter on. Default: false. */
  enabled: boolean;
  /** Target bucket (LAKEHOUSE_BUCKET). Required when enabled. */
  bucket?: string;
  /** S3-compatible endpoint (LAKEHOUSE_S3_ENDPOINT), e.g. http://localhost:9000 for MinIO. */
  endpoint?: string;
  /** LAKEHOUSE_S3_REGION (default us-east-1; MinIO ignores it but the SDK requires one). */
  region: string;
  /** LAKEHOUSE_S3_ACCESS_KEY — env only, never logged. */
  accessKeyId?: string;
  /** LAKEHOUSE_S3_SECRET_KEY — env only, never logged. */
  secretAccessKey?: string;
  /** Key prefix for all exported objects (default 'lakehouse'). */
  prefix: string;
  /** NODE_ENV snapshot, used for the fail-closed decision. */
  nodeEnv: string;
}

export const LAKEHOUSE_DEFAULT_PREFIX = 'lakehouse';

/** Pure env parser — trivially unit-testable, performs no I/O. */
export function loadLakehouseConfig(env: NodeJS.ProcessEnv = process.env): LakehouseConfig {
  const enabled = (env.LAKEHOUSE_ENABLED ?? '').trim().toLowerCase() === 'true';
  const prefix = (env.LAKEHOUSE_PREFIX ?? '').trim() || LAKEHOUSE_DEFAULT_PREFIX;
  return {
    enabled,
    bucket: env.LAKEHOUSE_BUCKET?.trim() || undefined,
    endpoint: env.LAKEHOUSE_S3_ENDPOINT?.trim() || undefined,
    region: env.LAKEHOUSE_S3_REGION?.trim() || 'us-east-1',
    accessKeyId: env.LAKEHOUSE_S3_ACCESS_KEY?.trim() || undefined,
    secretAccessKey: env.LAKEHOUSE_S3_SECRET_KEY?.trim() || undefined,
    prefix,
    nodeEnv: env.NODE_ENV ?? 'development'
  };
}

/** True when enabled but bucket/credentials are missing (fail-closed trigger). */
export function lakehouseConfigIncomplete(config: LakehouseConfig): boolean {
  if (!config.enabled) return false;
  return !config.bucket || !config.accessKeyId || !config.secretAccessKey;
}

/** The only config shape allowed into logs or API responses — no secrets. */
export function redactLakehouseConfig(config: LakehouseConfig): {
  enabled: boolean;
  bucket?: string;
  endpoint?: string;
  region: string;
  prefix: string;
  credentialsConfigured: boolean;
} {
  return {
    enabled: config.enabled,
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region,
    prefix: config.prefix,
    credentialsConfigured: Boolean(config.accessKeyId && config.secretAccessKey)
  };
}
