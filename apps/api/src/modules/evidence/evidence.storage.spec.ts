import { describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import {
  createEvidenceStorageDriver,
  EVIDENCE_PRESIGN_DEFAULT_TTL_SECONDS,
  EVIDENCE_PRESIGN_MAX_TTL_SECONDS,
  loadEvidenceS3Config,
  presignS3Url,
  S3EvidenceStorageDriver,
  StubEvidenceStorageDriver
} from './evidence.storage.js';

/**
 * SigV4 known-answer vectors verified byte-for-byte against AWS's own
 * reference implementation (botocore 1.43.91 S3SigV4QueryAuth, path-style,
 * frozen clock 2013-05-24T00:00:00Z, the documented example credentials).
 */

const AK = 'AKIAIOSFODNN7EXAMPLE';
const SK = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const NOW = new Date('2013-05-24T00:00:00Z');

describe('presignS3Url — SigV4 known answers (botocore-verified)', () => {
  it('GET examplebucket/test.txt reproduces the reference signature', () => {
    const url = presignS3Url({
      method: 'GET',
      endpoint: 'https://s3.amazonaws.com',
      region: 'us-east-1',
      bucket: 'examplebucket',
      objectKey: 'test.txt',
      accessKeyId: AK,
      secretAccessKey: SK,
      expiresInSeconds: 86400,
      now: NOW
    });
    expect(url).toBe(
      'https://s3.amazonaws.com/examplebucket/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z' +
        '&X-Amz-Expires=86400' +
        '&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=733255ef022bec3f2a8701cd61d4b371f3f28c9f193a1f02279211d48d5193d7'
    );
  });

  it('PUT with pinned sha256 metadata reproduces the reference signature', () => {
    const url = presignS3Url({
      method: 'PUT',
      endpoint: 'https://s3.amazonaws.com',
      region: 'us-east-1',
      bucket: 'examplebucket',
      objectKey: 'evidence/escrow/escrow-1/evi-1',
      accessKeyId: AK,
      secretAccessKey: SK,
      expiresInSeconds: 900,
      now: NOW,
      extraSignedHeaders: { 'x-amz-meta-sha256': 'a'.repeat(64) }
    });
    expect(url).toBe(
      'https://s3.amazonaws.com/examplebucket/evidence/escrow/escrow-1/evi-1' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z' +
        '&X-Amz-Expires=900' +
        '&X-Amz-SignedHeaders=host%3Bx-amz-meta-sha256' +
        '&X-Amz-Signature=cdb993fbc70a2a50cc433ec3236d4e2b218838effe174adab5caf9047c07f577'
    );
  });

  it('supports port-qualified S3-compatible endpoints (MinIO)', () => {
    const url = presignS3Url({
      method: 'GET',
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'evidence',
      objectKey: 'a/b.txt',
      accessKeyId: AK,
      secretAccessKey: SK,
      expiresInSeconds: 60,
      now: NOW
    });
    expect(url.startsWith('http://localhost:9000/evidence/a/b.txt?')).toBe(true);
    expect(url).toContain('X-Amz-Expires=60');
  });
});

describe('StubEvidenceStorageDriver — fail-closed default', () => {
  const stub = new StubEvidenceStorageDriver();

  it('answers 503 on every operation and never fabricates storage', async () => {
    await expect(stub.presignUpload()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(stub.stat()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(stub.presignDownload()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(stub.remove()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('loadEvidenceS3Config — boot-time fail-closed config', () => {
  it('throws ProviderConfigError when bucket is missing', () => {
    expect(() =>
      loadEvidenceS3Config({
        EVIDENCE_S3_ACCESS_KEY: 'x',
        EVIDENCE_S3_SECRET_KEY: 'y'
      })
    ).toThrowError(ProviderConfigError);
  });

  it('throws ProviderConfigError listing every missing variable', () => {
    try {
      loadEvidenceS3Config({});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderConfigError);
      expect((error as ProviderConfigError).missing).toEqual([
        'EVIDENCE_S3_BUCKET',
        'EVIDENCE_S3_ACCESS_KEY',
        'EVIDENCE_S3_SECRET_KEY'
      ]);
    }
  });

  it('parses a complete config with defaults', () => {
    const config = loadEvidenceS3Config({
      EVIDENCE_S3_BUCKET: 'evidence',
      EVIDENCE_S3_ACCESS_KEY: 'x',
      EVIDENCE_S3_SECRET_KEY: 'y'
    });
    expect(config.region).toBe('us-east-1');
    expect(config.endpoint).toBe('https://s3.us-east-1.amazonaws.com');
    expect(config.presignTtlSeconds).toBe(EVIDENCE_PRESIGN_DEFAULT_TTL_SECONDS);
  });

  it('caps the presign TTL', () => {
    const config = loadEvidenceS3Config({
      EVIDENCE_S3_BUCKET: 'evidence',
      EVIDENCE_S3_ACCESS_KEY: 'x',
      EVIDENCE_S3_SECRET_KEY: 'y',
      EVIDENCE_PRESIGN_TTL_SECONDS: '999999'
    });
    expect(config.presignTtlSeconds).toBe(EVIDENCE_PRESIGN_MAX_TTL_SECONDS);
  });
});

describe('createEvidenceStorageDriver', () => {
  it('defaults to the stub', () => {
    expect(createEvidenceStorageDriver({}).name).toBe('stub');
  });

  it('throws ProviderConfigError for an unknown driver name', () => {
    expect(() => createEvidenceStorageDriver({ EVIDENCE_STORAGE_DRIVER: 'gcs' })).toThrowError(
      ProviderConfigError
    );
  });

  it('throws ProviderConfigError when s3 is selected without config', () => {
    expect(() => createEvidenceStorageDriver({ EVIDENCE_STORAGE_DRIVER: 's3' })).toThrowError(
      ProviderConfigError
    );
  });
});

describe('S3EvidenceStorageDriver — stat/remove over the narrow client', () => {
  const config = loadEvidenceS3Config({
    EVIDENCE_S3_BUCKET: 'evidence',
    EVIDENCE_S3_ACCESS_KEY: 'x',
    EVIDENCE_S3_SECRET_KEY: 'y'
  });

  function fakeClient(behavior: (command: unknown) => Promise<unknown>) {
    return { send: behavior };
  }

  it('stat maps HeadObject output (size + pinned sha256 metadata)', async () => {
    const driver = new S3EvidenceStorageDriver(
      config,
      fakeClient(() =>
        Promise.resolve({ ContentLength: 2048, Metadata: { sha256: 'b'.repeat(64) } })
      )
    );
    const stat = await driver.stat('evidence/escrow/escrow-1/evi-1');
    expect(stat).toEqual({ sizeBytes: 2048, sha256: 'b'.repeat(64) });
  });

  it('stat returns null only for honest absence (NotFound)', async () => {
    const driver = new S3EvidenceStorageDriver(
      config,
      fakeClient(() => Promise.reject(Object.assign(new Error('nope'), { name: 'NotFound' })))
    );
    await expect(driver.stat('missing')).resolves.toBeNull();
  });

  it('stat propagates unreachable storage — never fakes a stat', async () => {
    const driver = new S3EvidenceStorageDriver(
      config,
      fakeClient(() => Promise.reject(Object.assign(new Error('boom'), { name: 'NetworkingError' })))
    );
    await expect(driver.stat('k')).rejects.toThrow('boom');
  });

  it('stat reports null sha256 when the pinned metadata is absent (unverifiable)', async () => {
    const driver = new S3EvidenceStorageDriver(
      config,
      fakeClient(() => Promise.resolve({ ContentLength: 10, Metadata: {} }))
    );
    const stat = await driver.stat('k');
    expect(stat?.sha256).toBeNull();
  });

  it('remove issues a delete for the object key', async () => {
    const seen: unknown[] = [];
    const driver = new S3EvidenceStorageDriver(
      config,
      fakeClient((command) => {
        seen.push(command);
        return Promise.resolve({});
      })
    );
    await driver.remove('evidence/escrow/escrow-1/evi-1');
    expect(seen).toHaveLength(1);
    expect((seen[0] as { input: { Key: string } }).input.Key).toBe(
      'evidence/escrow/escrow-1/evi-1'
    );
  });

  it('presignUpload returns a PUT URL whose headers pin the declared sha256', async () => {
    const driver = new S3EvidenceStorageDriver(config, fakeClient(() => Promise.resolve({})));
    const upload = await driver.presignUpload({
      objectKey: 'evidence/vsla/grp-1/evi-9',
      mime: 'image/jpeg',
      sizeBytes: 100,
      sha256: 'c'.repeat(64)
    });
    expect(upload.method).toBe('PUT');
    expect(upload.url).toContain('evidence/vsla/grp-1/evi-9');
    expect(upload.headers['x-amz-meta-sha256']).toBe('c'.repeat(64));
    expect(upload.url).toContain('X-Amz-SignedHeaders=host%3Bx-amz-meta-sha256');
    expect(Date.parse(upload.expiresAt) > Date.now()).toBe(true);
  });
});
