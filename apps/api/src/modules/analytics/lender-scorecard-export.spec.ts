/**
 * Lender Lens export tests (Stage 27, innovation #20):
 *   - projector -> scorecard -> parquet export round trip against a fake S3:
 *     the manifest's file entry sha256 matches the captured parquet bytes;
 *   - fail-closed: stub storage (no LAKEHOUSE_* config) -> 503, while the
 *     JSON scorecard endpoint keeps serving the real stored payload;
 *   - presign determinism and URL shape.
 */
import { createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Profile } from '@agric-platform/shared';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { createInMemoryFeatureFlagRepository } from '../../database/repositories/feature-flag.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAnalyticsStarRepository } from '../../database/repositories/analytics-star.repository.js';
import {
  InMemoryCreditLoanRepository,
  InMemoryCreditRepaymentRepository
} from '../../database/repositories/credit-suite.repository.js';
import { createInMemoryLenderScorecardRepository } from '../../database/repositories/lender-scorecard.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { InMemoryProfileRepository } from '../../database/repositories/profile.repository.js';
import { presignGetObject } from './exporter/s3-presign.js';
import {
  LenderScorecardExportService,
  loadLenderLensExportConfig,
  SCORECARD_URL_TTL_SECONDS
} from './lender-scorecard-export.service.js';
import { LENDER_LENS_FLAG, LenderScorecardService } from './lender-scorecard.service.js';
import type { LakehouseS3 } from './exporter/lakehouse-exporter.service.js';
import type { LakehouseConfig } from './exporter/lakehouse.config.js';

const PERIOD = '2026-08';

interface CapturedPut {
  key: string;
  body: Buffer | string;
}

class FakeS3 implements LakehouseS3 {
  readonly puts: CapturedPut[] = [];
  async send(command: unknown): Promise<unknown> {
    const put = command as PutObjectCommand;
    this.puts.push({
      key: String(put.input.Key),
      body: put.input.Body as Buffer | string
    });
    return {};
  }
}

const ADMIN = {
  id: 'admin-1',
  phone: '08000000000',
  fullName: 'Admin',
  roles: ['admin' as const],
  preferredLanguage: 'en' as const,
  kycTier: 'tier_3' as const,
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};

function liveConfig(): LakehouseConfig {
  return loadLenderLensExportConfig({
    LAKEHOUSE_ENABLED: 'true',
    LAKEHOUSE_BUCKET: 'lens-bucket',
    LAKEHOUSE_S3_ENDPOINT: 'http://localhost:9000',
    LAKEHOUSE_S3_REGION: 'us-east-1',
    LAKEHOUSE_S3_ACCESS_KEY: 'test-access-key',
    LAKEHOUSE_S3_SECRET_KEY: 'test-secret-key',
    NODE_ENV: 'test'
  });
}

function serviceHarness(config: LakehouseConfig, s3: LakehouseS3 | null) {
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const scorecards = new LenderScorecardService(
    createInMemoryLenderScorecardRepository(),
    new InMemoryCreditLoanRepository([
      {
        id: 'loan-1',
        applicantUserId: 'borrower-1',
        productId: 'prod-cash',
        principalKobo: 100_000,
        status: 'repaying',
        createdAt: '2026-05-10T08:00:00.000Z',
        updatedAt: '2026-05-10T08:00:00.000Z'
      }
    ]),
    new InMemoryCreditRepaymentRepository([
      {
        id: 'r-1',
        loanId: 'loan-1',
        sequence: 1,
        dueAt: '2026-07-15T00:00:00.000Z',
        amountKobo: 100_000,
        status: 'pending'
      }
    ]),
    new InMemoryProfileRepository([
      {
        userId: 'borrower-1',
        location: { state: 'Kaduna', lga: 'test' },
        farmingInterests: [],
        valueChains: [],
        completionScore: 0,
        badges: []
      } as Profile
    ]),
    outbox,
    createInMemoryAnalyticsStarRepository(),
    events,
    new FeatureFlagsService(
      createInMemoryFeatureFlagRepository([
        { key: LENDER_LENS_FLAG, enabled: true, roleAllowlist: [], percentage: 100, description: 't' }
      ])
    ),
    new TelemetryService()
  );
  const exports = new LenderScorecardExportService(scorecards, config, s3, new TelemetryService());
  return { scorecards, exports, events };
}

describe('LenderScorecardExportService', () => {
  it('round trip: scorecard -> parquet part + manifest with matching hashes', async () => {
    const s3 = new FakeS3();
    const { scorecards, exports, events } = serviceHarness(liveConfig(), s3);
    await scorecards.publishVersion(ADMIN, { version: '1.0.0', definition: {} });
    await events.publish(
      'partner.disbursement.recorded',
      { partnerId: 'lender-a', userId: 'borrower-1' },
      'test'
    );

    const result = await exports.export('lender-a', PERIOD);

    expect(result.version).toBe('1.0.0');
    expect(result.period).toBe(PERIOD);
    expect(s3.puts).toHaveLength(2);
    const [partPut, manifestPut] = s3.puts;
    expect(partPut!.key).toBe(`lakehouse/lender-scorecards/lender=lender-a/period=${PERIOD}/scorecard-1.0.0.parquet`);
    expect(manifestPut!.key).toBe(`lakehouse/lender-scorecards/lender=lender-a/period=${PERIOD}/manifest-1.0.0.json`);

    // Parquet magic bytes + manifest hash matches the actual part bytes.
    const partBytes = partPut!.body as Buffer;
    expect(partBytes.subarray(0, 4).toString('latin1')).toBe('PAR1');
    const partSha = createHash('sha256').update(partBytes).digest('hex');
    expect(partSha).toBe(result.parquetSha256);
    const manifest = JSON.parse(String(manifestPut!.body)) as {
      payloadHash: string;
      files: { key: string; bytes: number; sha256: string }[];
    };
    expect(manifest.files).toEqual([{ key: partPut!.key, bytes: partBytes.length, sha256: partSha }]);
    expect(manifest.payloadHash).toBe(result.payloadHash);

    // Presigned URLs: deterministic shape, 1h expiry, path-style host. The
    // key is URI-encoded per SigV4 ('=' -> %3D in the canonical URI).
    const encodedKey = partPut!.key.split('/').map(encodeURIComponent).join('/');
    expect(result.url).toContain(`http://localhost:9000/lens-bucket/${encodedKey}?`);
    expect(result.url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(result.url).toContain(`X-Amz-Expires=${SCORECARD_URL_TTL_SECONDS}`);
    expect(result.url).toContain('X-Amz-Signature=');
    expect(result.manifestUrl).toContain(
      manifestPut!.key.split('/').map(encodeURIComponent).join('/')
    );
    expect(new Date(result.urlExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('fails closed 503 with stub storage while JSON reads keep serving', async () => {
    const { scorecards, exports, events } = serviceHarness(
      loadLenderLensExportConfig({ NODE_ENV: 'production' }),
      null
    );
    await scorecards.publishVersion(ADMIN, { version: '1.0.0', definition: {} });
    await events.publish(
      'partner.disbursement.recorded',
      { partnerId: 'lender-a', userId: 'borrower-1' },
      'test'
    );
    // JSON endpoint serves the real stored payload even in production...
    const envelope = await scorecards.scorecard('lender-a', PERIOD);
    expect(envelope.payload.portfolio.activeLoans).toBe(1);
    // ...while the export endpoint refuses (no fabricated export).
    await expect(exports.export('lender-a', PERIOD)).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  it('presigns deterministically for fixed inputs', () => {
    const input = {
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'b',
      key: 'p/lender=lender-a/period=2026-08/scorecard-1.0.0.parquet',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      expiresSeconds: 3600,
      now: new Date('2026-09-01T12:00:00.000Z')
    };
    const a = presignGetObject(input);
    const b = presignGetObject(input);
    expect(a).toBe(b);
    expect(a).toContain('X-Amz-Date=20260901T120000Z');
    expect(a).toContain('X-Amz-Credential=AKID%2F20260901%2Fus-east-1%2Fs3%2Faws4_request');
    // Signature is 64 lower-case hex chars at the end of the query string.
    const signature = a.split('X-Amz-Signature=')[1] ?? '';
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });
});
