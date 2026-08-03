import { createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { ParquetReader } from 'parquetjs-lite';
import { describe, expect, it } from 'vitest';
import { InMemoryAnalyticsStarRepository } from '../../../database/repositories/analytics-star.repository.js';
import {
  lakehouseConfigIncomplete,
  loadLakehouseConfig,
  redactLakehouseConfig,
  type LakehouseConfig
} from './lakehouse.config.js';
import { LAKEHOUSE_TABLES } from './lakehouse-parquet.js';
import {
  LakehouseExporterService,
  type LakehouseManifest,
  type LakehouseS3
} from './lakehouse-exporter.service.js';

/**
 * Lakehouse exporter contract: hive-style partition layout, manifest content
 * (row counts + SHA-256), idempotent same-day re-runs, fail-closed init and
 * the honest disabled state. S3 is a Map-backed fake implementing the narrow
 * LakehouseS3 surface; parquet validity is verified by real readback.
 */

interface StoredObject {
  body: Buffer;
}

class FakeS3 implements LakehouseS3 {
  readonly objects = new Map<string, StoredObject>();

  private id(command: unknown): string {
    return (command as { constructor: { name: string } }).constructor.name;
  }

  private input(command: unknown): { Bucket: string; Key: string; Body?: unknown; Prefix?: string } {
    return (command as { input: never }).input;
  }

  async send(command: unknown): Promise<unknown> {
    const input = this.input(command);
    const fullKey = `${input.Bucket}/${input.Key}`;
    switch (this.id(command)) {
      case 'PutObjectCommand': {
        const body = Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(String(input.Body));
        this.objects.set(fullKey, { body });
        return {};
      }
      case 'GetObjectCommand': {
        const found = this.objects.get(fullKey);
        if (!found) {
          const error = new Error('NoSuchKey') as Error & { name: string };
          error.name = 'NoSuchKey';
          throw error;
        }
        return { Body: { transformToString: async () => found.body.toString('utf8') } };
      }
      case 'ListObjectsV2Command': {
        const prefix = `${input.Bucket}/${input.Prefix ?? ''}`;
        return {
          Contents: [...this.objects.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({ Key: key.slice(input.Bucket.length + 1) }))
        };
      }
      case 'DeleteObjectCommand': {
        this.objects.delete(fullKey);
        return {};
      }
      default:
        throw new Error(`FakeS3: unsupported command ${this.id(command)}`);
    }
  }

  keys(bucket: string): string[] {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(`${bucket}/`))
      .map((key) => key.slice(bucket.length + 1))
      .sort();
  }

  get(bucket: string, key: string): Buffer | undefined {
    return this.objects.get(`${bucket}/${key}`)?.body;
  }
}

const RUN_DATE = '2026-08-06';
const RUN_NOW = new Date('2026-08-06T12:00:00.000Z');

function makeConfig(overrides: Partial<LakehouseConfig> = {}): LakehouseConfig {
  return {
    enabled: true,
    bucket: 'agric-lakehouse',
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    accessKeyId: 'test-access',
    secretAccessKey: 'test-secret',
    prefix: 'lakehouse',
    nodeEnv: 'test',
    ...overrides
  };
}

async function seededStar() {
  const star = new InMemoryAnalyticsStarRepository();
  await star.upsertDimUser({
    userId: 'u1',
    roles: ['farmer', 'admin'],
    state: 'Lagos',
    registeredAt: '2026-08-01T09:00:00.000Z'
  });
  await star.upsertDimListing({
    listingId: 'l1',
    sellerId: 'u1',
    kind: 'produce',
    crop: 'maize',
    state: 'Kano',
    createdAt: '2026-08-02T09:00:00.000Z'
  });
  await star.upsertFactOrder({
    orderId: 'o1',
    listingId: 'l1',
    buyerId: 'u2',
    sellerId: 'u1',
    channel: 'web',
    quantity: 2,
    totalKobo: 5_000_000,
    status: 'completed',
    statusHistoryCount: 3,
    escrowRequired: true,
    placedAt: '2026-08-05T10:00:00.000Z',
    fulfilledAt: '2026-08-06T08:00:00.000Z'
  });
  await star.upsertFactPayment({
    entryId: 'e1',
    idempotencyKey: 'k1',
    referenceType: 'marketplace_order',
    referenceId: 'o1',
    debitAccounts: ['escrow:held'],
    creditAccounts: ['buyer:wallet', 'buyer:card'],
    amountKobo: 5_000_000,
    postedAt: '2026-08-05T10:05:00.000Z'
  });
  await star.upsertFactLivestock({
    animalId: 'a1',
    ownerUserId: 'u1',
    species: 'cattle',
    breed: 'sokoto gudali',
    state: 'Sokoto',
    status: 'active',
    registeredAt: '2026-08-04T07:00:00.000Z'
  });
  await star.upsertDailyMetric({
    metricDate: '2026-08-05',
    ordersGmvKobo: 5_000_000,
    ordersCount: 1,
    activeFarmers: 1,
    escrowHeldKobo: 5_000_000,
    livestockRegistered: 0
  });
  return star;
}

async function makeExporter(configOverrides: Partial<LakehouseConfig> = {}) {
  const star = await seededStar();
  const s3 = new FakeS3();
  const config = makeConfig(configOverrides);
  const service = new LakehouseExporterService(star, config, s3);
  return { service, star, s3, config };
}

async function readParquetRows(buffer: Buffer): Promise<Record<string, unknown>[]> {
  const reader = await ParquetReader.openBuffer(buffer);
  const cursor = reader.getCursor();
  const rows: Record<string, unknown>[] = [];
  let record: Record<string, unknown> | null;
  while ((record = (await cursor.next()) as Record<string, unknown> | null)) {
    rows.push(record);
  }
  await reader.close();
  return rows;
}

describe('lakehouse config', () => {
  it('is disabled by default with no env set', () => {
    const config = loadLakehouseConfig({});
    expect(config.enabled).toBe(false);
    expect(config.bucket).toBeUndefined();
    expect(config.region).toBe('us-east-1');
    expect(config.prefix).toBe('lakehouse');
    expect(lakehouseConfigIncomplete(config)).toBe(false);
  });

  it('parses the full enabled configuration from env', () => {
    const config = loadLakehouseConfig({
      LAKEHOUSE_ENABLED: 'true',
      LAKEHOUSE_BUCKET: 'bucket-x',
      LAKEHOUSE_S3_ENDPOINT: 'http://minio:9000',
      LAKEHOUSE_S3_REGION: 'eu-west-1',
      LAKEHOUSE_S3_ACCESS_KEY: 'ak',
      LAKEHOUSE_S3_SECRET_KEY: 'sk'
    });
    expect(config).toMatchObject({
      enabled: true,
      bucket: 'bucket-x',
      endpoint: 'http://minio:9000',
      region: 'eu-west-1'
    });
    expect(lakehouseConfigIncomplete(config)).toBe(false);
  });

  it('flags enabled-but-incomplete configs (bucket or credentials missing)', () => {
    expect(lakehouseConfigIncomplete(makeConfig({ bucket: undefined }))).toBe(true);
    expect(lakehouseConfigIncomplete(makeConfig({ accessKeyId: undefined }))).toBe(true);
    expect(lakehouseConfigIncomplete(makeConfig({ secretAccessKey: undefined }))).toBe(true);
  });

  it('redaction never exposes credentials', () => {
    const redacted = redactLakehouseConfig(makeConfig());
    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain('test-access');
    expect(serialised).not.toContain('test-secret');
    expect(redacted).toMatchObject({ enabled: true, credentialsConfigured: true });
  });
});

describe('fail-closed module init', () => {
  it('throws in production when enabled but the bucket is missing', () => {
    const service = new LakehouseExporterService(
      new InMemoryAnalyticsStarRepository(),
      makeConfig({ bucket: undefined, nodeEnv: 'production' }),
      null
    );
    expect(() => service.onModuleInit()).toThrow(/fail-closed/);
  });

  it('throws in production when enabled but credentials are missing', () => {
    const service = new LakehouseExporterService(
      new InMemoryAnalyticsStarRepository(),
      makeConfig({ secretAccessKey: undefined, nodeEnv: 'production' }),
      null
    );
    expect(() => service.onModuleInit()).toThrow(/LAKEHOUSE_S3/);
  });

  it('degrades to disabled (no throw) outside production', async () => {
    const service = new LakehouseExporterService(
      new InMemoryAnalyticsStarRepository(),
      makeConfig({ bucket: undefined, nodeEnv: 'development' }),
      null
    );
    expect(() => service.onModuleInit()).not.toThrow();
    expect(service.isEnabled()).toBe(false);
    await expect(service.runExport(RUN_NOW)).rejects.toBeInstanceOf(ServiceUnavailableException);
    const status = await service.lastExportStatus();
    expect(status.enabled).toBe(false);
    expect(status.reason).toContain('LAKEHOUSE_ENABLED=true');
  });

  it('stays disabled cleanly when LAKEHOUSE_ENABLED is false', async () => {
    const star = new InMemoryAnalyticsStarRepository();
    const service = new LakehouseExporterService(star, makeConfig({ enabled: false }), null);
    expect(() => service.onModuleInit()).not.toThrow();
    await expect(service.runExport(RUN_NOW)).rejects.toBeInstanceOf(ServiceUnavailableException);
    const status = await service.lastExportStatus();
    expect(status).toMatchObject({ enabled: false, manifest: null });
  });
});

describe('export run', () => {
  it('writes one parquet part-file per mart table under hive-style dt= partitions', async () => {
    const { service, s3 } = await makeExporter();
    const manifest = await service.runExport(RUN_NOW);
    const keys = s3.keys('agric-lakehouse');
    for (const table of LAKEHOUSE_TABLES) {
      expect(keys).toContain(
        `lakehouse/${table}/dt=${RUN_DATE}/part-${manifest.runId}-00000.parquet`
      );
    }
    // Every part file carries the parquet magic bytes.
    for (const tableExport of manifest.tables) {
      const bytes = s3.get('agric-lakehouse', tableExport.files[0].key) as Buffer;
      expect(bytes.subarray(0, 4).toString()).toBe('PAR1');
    }
  });

  it('part files are valid parquet with the mart rows and snake_case columns', async () => {
    const { service, s3 } = await makeExporter();
    const manifest = await service.runExport(RUN_NOW);
    const ordersFile = manifest.tables.find((t) => t.table === 'fact_orders')?.files[0];
    const rows = await readParquetRows(s3.get('agric-lakehouse', ordersFile?.key ?? '') as Buffer);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      order_id: 'o1',
      channel: 'web',
      quantity: 2,
      status: 'completed',
      escrow_required: true
    });
    const usersFile = manifest.tables.find((t) => t.table === 'dim_users')?.files[0];
    const users = await readParquetRows(s3.get('agric-lakehouse', usersFile?.key ?? '') as Buffer);
    // REPEATED UTF8 round-trips as an array.
    expect(users[0]).toMatchObject({ user_id: 'u1', state: 'Lagos' });
    expect((users[0].roles as { list?: unknown[] } | string[])).toBeTruthy();
  });

  it('manifest records run id, tables, row counts, byte sizes and sha256 per file', async () => {
    const { service, s3 } = await makeExporter();
    const manifest = await service.runExport(RUN_NOW);
    expect(manifest).toMatchObject({
      runDate: RUN_DATE,
      bucket: 'agric-lakehouse',
      prefix: 'lakehouse',
      format: 'parquet',
      totalRows: 6,
      tables: expect.arrayContaining([
        expect.objectContaining({ table: 'fact_orders', rows: 1 }),
        expect.objectContaining({ table: 'mart_daily_metrics', rows: 1 })
      ])
    });
    expect(manifest.startedAt).toBe(RUN_NOW.toISOString());
    for (const table of manifest.tables) {
      const file = table.files[0];
      const bytes = s3.get('agric-lakehouse', file.key) as Buffer;
      expect(file.bytes).toBe(bytes.length);
      expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('persists the run manifest and flips the _manifest.json latest pointer', async () => {
    const { service, s3 } = await makeExporter();
    const manifest = await service.runExport(RUN_NOW);
    const runKey = `lakehouse/_manifests/dt=${RUN_DATE}/${manifest.runId}.json`;
    const runManifest = JSON.parse(
      (s3.get('agric-lakehouse', runKey) as Buffer).toString('utf8')
    ) as LakehouseManifest;
    expect(runManifest.runId).toBe(manifest.runId);
    const latest = JSON.parse(
      (s3.get('agric-lakehouse', 'lakehouse/_manifest.json') as Buffer).toString('utf8')
    ) as LakehouseManifest;
    expect(latest.runId).toBe(manifest.runId);
  });

  it('manifests never contain credentials', async () => {
    const { service, s3 } = await makeExporter();
    const manifest = await service.runExport(RUN_NOW);
    const latest = (s3.get('agric-lakehouse', 'lakehouse/_manifest.json') as Buffer).toString(
      'utf8'
    );
    expect(latest).not.toContain('test-access');
    expect(latest).not.toContain('test-secret');
    expect(JSON.stringify(manifest)).not.toContain('test-secret');
  });

  it('re-running the same day replaces the partition (stale parts deleted, pointer flipped)', async () => {
    const { service, s3 } = await makeExporter();
    const first = await service.runExport(RUN_NOW);
    const second = await service.runExport(RUN_NOW);
    expect(second.runId).not.toBe(first.runId);

    // The first run's part files are gone; only the second run's remain.
    const partKeys = s3.keys('agric-lakehouse').filter((key) => key.endsWith('.parquet'));
    expect(partKeys).toHaveLength(LAKEHOUSE_TABLES.length);
    expect(partKeys.every((key) => key.includes(second.runId))).toBe(true);
    expect(partKeys.some((key) => key.includes(first.runId))).toBe(false);

    // Both run manifests persist (audit trail); the latest pointer flipped.
    const keys = s3.keys('agric-lakehouse');
    expect(keys).toContain(`lakehouse/_manifests/dt=${RUN_DATE}/${first.runId}.json`);
    expect(keys).toContain(`lakehouse/_manifests/dt=${RUN_DATE}/${second.runId}.json`);
    const latest = JSON.parse(
      (s3.get('agric-lakehouse', 'lakehouse/_manifest.json') as Buffer).toString('utf8')
    ) as LakehouseManifest;
    expect(latest.runId).toBe(second.runId);

    // In-memory status reflects the latest run.
    const status = await service.lastExportStatus();
    expect(status.manifest?.runId).toBe(second.runId);
  });
});

describe('last export status', () => {
  it('reads the latest manifest from object storage after a restart (empty memory)', async () => {
    const { service, s3, star, config } = await makeExporter();
    const manifest = await service.runExport(RUN_NOW);
    // Simulate an API restart: new service instance, same storage + config.
    const restarted = new LakehouseExporterService(star, config, s3);
    const status = await restarted.lastExportStatus();
    expect(status.enabled).toBe(true);
    expect(status.bucket).toBe('agric-lakehouse');
    expect(status.manifest?.runId).toBe(manifest.runId);
  });

  it('reports manifest:null before the first run (honest empty state)', async () => {
    const { service } = await makeExporter();
    const status = await service.lastExportStatus();
    expect(status).toMatchObject({ enabled: true, manifest: null });
  });
});
