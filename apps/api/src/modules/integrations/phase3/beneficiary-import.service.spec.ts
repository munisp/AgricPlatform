import { describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../../database/repositories/outbox.repository.js';
import {
  createInMemoryImportBatchRepository,
  createInMemoryImportRecordRepository
} from '../../../database/repositories/phase3.repository.js';
import { createInMemoryUserRepository } from '../../../database/repositories/user.repository.js';
import { seedUsers } from '../../../database/seed-data.js';
import type { FieldDataSource } from '../drivers/field-data.clients.js';
import {
  BeneficiaryImportService,
  submissionToRow,
  type BeneficiaryRowInput
} from './beneficiary-import.service.js';
import { normalisePhone, sha256 } from './phase3.utils.js';

function setup(sources: FieldDataSource[] = []) {
  const batches = createInMemoryImportBatchRepository();
  const records = createInMemoryImportRecordRepository();
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const service = new BeneficiaryImportService(
    batches,
    records,
    createInMemoryUserRepository(),
    events,
    sources
  );
  return { batches, records, events, service };
}

const row = (overrides: Partial<BeneficiaryRowInput> = {}): BeneficiaryRowInput => ({
  phone: '0803 111 2222',
  consentDate: '2026-04-15T00:00:00.000Z',
  attributes: { community: 'Makurdi' },
  ...overrides
});

describe('BeneficiaryImportService', () => {
  it('stages a validated batch with hashed identity fields and donor tagging', async () => {
    const { service, records } = setup();
    const batch = await service.createBatch(
      { sourceSystem: 'kobo', donorSource: 'NGO-AgroAid', records: [row()] },
      'admin-1'
    );
    expect(batch).toMatchObject({ status: 'STAGED', recordCount: 1, donorSource: 'NGO-AgroAid' });
    const staged = await records.find({ batchId: batch.id, status: 'STAGED' });
    expect(staged).toHaveLength(1);
    expect(staged[0].phoneHash).toBe(sha256(normalisePhone('0803 111 2222')));
    expect(staged[0].donorSource).toBe('NGO-AgroAid');
    expect(staged[0].consentDate).toBe('2026-04-15T00:00:00.000Z');
    // Raw identity values never persist (only their SHA-256 hashes).
    expect(JSON.stringify(staged[0])).not.toContain('0803 111 2222');
    expect(staged[0].payload['phone']).toBeUndefined();
  });

  it('rejects invalid rows and within-batch duplicates with reasons', async () => {
    const { service, records } = setup();
    const batch = await service.createBatch(
      {
        sourceSystem: 'odk',
        donorSource: 'DonorX',
        records: [
          row(),
          row(), // duplicate phone → rejected
          row({ phone: '0805 999 0000', consentDate: '' }), // no consent → rejected
          row({ phone: '', nin: '' }), // no identity → rejected
          row({ phone: '0901 222 3333', nin: ' 1234 567 ' })
        ]
      },
      'admin-1'
    );
    const all = await records.find({ batchId: batch.id });
    expect(all).toHaveLength(5);
    const rejected = all.filter((record) => record.status === 'REJECTED');
    expect(rejected).toHaveLength(3);
    const reasons = rejected.map((record) => record.payload['rejectionReason']);
    expect(reasons).toEqual(
      expect.arrayContaining([
        'duplicate of an earlier row in this batch',
        'missing or invalid consentDate',
        'row needs at least one of phone or nin'
      ])
    );
    const ninRow = all.find((record) => record.ninHash);
    expect(ninRow?.ninHash).toBe(sha256('1234567'));
  });

  it('deduplicates against identity.users by phone hash', async () => {
    const { service, records } = setup();
    const existing = seedUsers[0];
    const batch = await service.createBatch(
      { sourceSystem: 'kobo', donorSource: 'NGO-AgroAid', records: [row({ phone: existing.phone })] },
      'admin-1'
    );
    const staged = await records.find({ batchId: batch.id, status: 'STAGED' });
    expect(staged[0].matchedUserId).toBe(existing.id);
    expect(staged[0].payload['matchNote']).toBe('matches existing platform user');
  });

  it('confirm flips STAGED to MERGED and closes the batch (once)', async () => {
    const { service, records } = setup();
    const batch = await service.createBatch(
      { sourceSystem: 'csv_upload', donorSource: 'DonorY', records: [row(), row()] },
      'admin-1'
    );
    const result = await service.confirmBatch(batch.id, 'admin-2');
    expect(result).toMatchObject({ merged: 1, rejected: 1 });
    expect(result.batch).toMatchObject({ status: 'CONFIRMED', confirmedBy: 'admin-2' });
    expect(result.batch.confirmedAt).toBeTruthy();
    expect(await records.find({ batchId: batch.id, status: 'MERGED' })).toHaveLength(1);
    await expect(service.confirmBatch(batch.id, 'admin-2')).rejects.toThrow(/already been confirmed/);
  });

  it('validates batch input', async () => {
    const { service } = setup();
    await expect(
      service.createBatch({ sourceSystem: '', donorSource: 'D', records: [row()] }, 'a')
    ).rejects.toThrow(/required/);
    await expect(
      service.createBatch({ sourceSystem: 'kobo', donorSource: 'D', records: [] }, 'a')
    ).rejects.toThrow(/non-empty/);
  });

  it('pulls submissions from configured sources into staged batches', async () => {
    const source: FieldDataSource = {
      name: 'kobo',
      fetchSubmissions: async () => [
        { name: 'Amina', phone: '0801 555 6666', consent_date: '2026-04-01' },
        { name: 'NoConsent', phone: '0801 555 7777' }
      ]
    };
    const { service, records } = setup([source]);
    const batchIds = await service.pullFromSources('NGO-AgroAid', 'admin-1');
    expect(batchIds).toHaveLength(1);
    const staged = await records.find({ batchId: batchIds[0] });
    expect(staged).toHaveLength(2);
    expect(staged.filter((record) => record.status === 'STAGED')).toHaveLength(1);
    expect(staged[0].donorSource).toBe('NGO-AgroAid');
  });

  it('pull is inert without configured sources (stub driver)', async () => {
    const { service } = setup();
    expect(await service.pullFromSources('NGO', 'admin-1')).toEqual([]);
  });
});

describe('submissionToRow', () => {
  it('maps known identity fields and carries the rest as attributes', () => {
    expect(
      submissionToRow({ nin: ' 12 34 ', phone_number: '0801', consent_date: '2026-04-01', village: 'Gboko' })
    ).toEqual({
      nin: ' 12 34 ',
      phone: '0801',
      consentDate: '2026-04-01',
      attributes: { village: 'Gboko' }
    });
  });
});
