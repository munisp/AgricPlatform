import { describe, expect, it } from 'vitest';
import {
  createInMemoryExternalAccountLinkRepository,
  createInMemoryFarmRecordRepository,
  createInMemoryImportBatchRepository,
  createInMemoryImportRecordRepository,
  createInMemoryInboundEventRepository,
  type ExternalAccountLink,
  type FarmRecord,
  type ImportBatch,
  type ImportRecord,
  type InboundEvent
} from './phase3.repository.js';

const link: ExternalAccountLink = {
  id: 'link-1',
  userId: 'user-1',
  system: 'farmos',
  externalId: 'farm-9',
  consentAt: '2026-02-01T00:00:00.000Z',
  createdAt: '2026-02-01T00:00:00.000Z'
};

const record: FarmRecord = {
  id: 'frec-1',
  linkId: 'link-1',
  recordType: 'harvest',
  externalId: 'log-1',
  payload: { crop: 'Maize', quantityKg: 1200 },
  source: 'farmos',
  observedAt: '2026-03-01T00:00:00.000Z',
  syncedAt: '2026-03-02T00:00:00.000Z'
};

describe('InMemoryExternalAccountLinkRepository', () => {
  it('filters by user, system and active-only', async () => {
    const repo = createInMemoryExternalAccountLinkRepository([
      link,
      { ...link, id: 'link-2', system: 'litefarm', revokedAt: '2026-04-01T00:00:00.000Z' }
    ]);
    expect(await repo.find({ userId: 'user-1' })).toHaveLength(2);
    expect(await repo.find({ userId: 'user-1', system: 'farmos' })).toHaveLength(1);
    expect(await repo.find({ userId: 'user-1', activeOnly: true })).toHaveLength(1);
  });
});

describe('InMemoryFarmRecordRepository', () => {
  it('upsertMany dedupes on (linkId, recordType, externalId)', async () => {
    const repo = createInMemoryFarmRecordRepository();
    expect(await repo.upsertMany([record])).toBe(1);
    // Replay with a fresh row id but the same natural key is skipped.
    expect(await repo.upsertMany([{ ...record, id: 'frec-2' }])).toBe(0);
    expect(await repo.all()).toHaveLength(1);
    // A different record type for the same external id inserts.
    expect(await repo.upsertMany([{ ...record, id: 'frec-3', recordType: 'crop_plan' }])).toBe(1);
  });
});

describe('InMemoryImportBatchRepository / InMemoryImportRecordRepository', () => {
  const batch: ImportBatch = {
    id: 'batch-1',
    sourceSystem: 'kobo',
    donorSource: 'NGO-AgroAid',
    status: 'STAGED',
    recordCount: 1,
    createdBy: 'admin-1',
    createdAt: '2026-05-01T00:00:00.000Z'
  };
  const row: ImportRecord = {
    id: 'irec-1',
    batchId: 'batch-1',
    phoneHash: 'abc123',
    payload: { name: 'Beneficiary' },
    status: 'STAGED',
    donorSource: 'NGO-AgroAid',
    consentDate: '2026-04-15T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z'
  };

  it('filters batches by status and records by batch/status/hash', async () => {
    const batches = createInMemoryImportBatchRepository([batch]);
    const records = createInMemoryImportRecordRepository([row]);
    expect(await batches.find({ status: 'STAGED' })).toHaveLength(1);
    expect(await batches.find({ status: 'CONFIRMED' })).toHaveLength(0);
    expect(await records.find({ batchId: 'batch-1', status: 'STAGED' })).toHaveLength(1);
    expect(await records.findOne({ phoneHash: 'abc123' })).toMatchObject({ id: 'irec-1' });
    expect(await records.find({ ninHash: 'missing' })).toHaveLength(0);
  });
});

describe('InMemoryInboundEventRepository', () => {
  const event: InboundEvent = {
    id: 'evt-1',
    system: 'ofn',
    eventType: 'order.created',
    dedupeKey: 'ofn-order-77',
    payload: { order: 77 },
    receivedAt: '2026-05-02T00:00:00.000Z'
  };

  it('ingest is idempotent per (system, dedupeKey)', async () => {
    const repo = createInMemoryInboundEventRepository();
    expect(await repo.ingest(event)).toMatchObject({ id: 'evt-1' });
    expect(await repo.ingest({ ...event, id: 'evt-2' })).toBeUndefined();
    expect(await repo.all()).toHaveLength(1);
  });

  it('markProcessed stamps processedAt', async () => {
    const repo = createInMemoryInboundEventRepository([event]);
    const processed = await repo.markProcessed('evt-1', '2026-05-02T00:01:00.000Z');
    expect(processed.processedAt).toBe('2026-05-02T00:01:00.000Z');
  });
});
