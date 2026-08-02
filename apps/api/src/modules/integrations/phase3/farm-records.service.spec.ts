import { describe, expect, it } from 'vitest';
import {
  createInMemoryExternalAccountLinkRepository,
  createInMemoryFarmRecordRepository,
  createInMemoryInboundEventRepository,
  type ExternalAccountLink
} from '../../../database/repositories/phase3.repository.js';
import type { FarmRecordClient } from '../drivers/farmos.clients.js';
import { FarmRecordsService, normalisePushedRecord } from './farm-records.service.js';

const link: ExternalAccountLink = {
  id: 'link-1',
  userId: 'user-1',
  system: 'farmos',
  externalId: 'farm-42',
  consentAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z'
};

const fakeClient = (name = 'farmos'): FarmRecordClient & { pushed: Array<[string, boolean]> } => ({
  name,
  pushed: [],
  async fetchRecords() {
    return [
      {
        recordType: 'harvest',
        externalId: 'log-1',
        payload: { crop: 'Maize' },
        source: name,
        observedAt: '2026-03-01T00:00:00.000Z'
      }
    ];
  },
  async pushMemberVerification(externalAccountId: string, verified: boolean) {
    this.pushed.push([externalAccountId, verified]);
  }
});

function setup(clientOverrides?: FarmRecordClient[], env: NodeJS.ProcessEnv = {}) {
  const links = createInMemoryExternalAccountLinkRepository([link]);
  const records = createInMemoryFarmRecordRepository();
  const inbound = createInMemoryInboundEventRepository();
  const client = fakeClient();
  const service = new FarmRecordsService(
    links,
    records,
    inbound,
    clientOverrides ?? [client],
    env
  );
  return { links, records, inbound, client, service };
}

describe('FarmRecordsService', () => {
  it('syncs a linked account into normalised farm records (replay-safe)', async () => {
    const { service, records } = setup();
    expect(await service.syncLink('link-1')).toBe(1);
    expect(await service.syncLink('link-1')).toBe(0); // replay-safe upsert
    const stored = await records.all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      linkId: 'link-1',
      recordType: 'harvest',
      externalId: 'log-1',
      source: 'farmos'
    });
  });

  it('refuses to sync a revoked link', async () => {
    const { service, links } = setup();
    await links.update('link-1', { revokedAt: '2026-04-01T00:00:00.000Z' });
    await expect(service.syncLink('link-1')).rejects.toThrow(/revoked/);
  });

  it('fails closed when the driver is stub (no client)', async () => {
    const { service } = setup([], { FARM_RECORDS_DRIVER: 'stub' });
    expect(service.enabled).toBe(false);
    await expect(service.syncLink('link-1')).rejects.toThrow(/No live farmos client/);
    await expect(service.pushVerification('link-1', true)).rejects.toThrow(/No live farmos client/);
  });

  it('pushes member verification through the matching client', async () => {
    const { service, client } = setup();
    await service.pushVerification('link-1', true);
    expect(client.pushed).toEqual([['farm-42', true]]);
  });

  it('ledgers webhook events replay-safe and upserts pushed records', async () => {
    const { service, inbound, records } = setup();
    const payload = {
      event: 'record.pushed',
      account_id: 'farm-42',
      record_type: 'crop_plan',
      record_id: 'plan-7',
      observed_at: '2026-03-05T00:00:00Z'
    };
    const first = await service.handleWebhook('farmos', payload, 'evt-100');
    expect(first.received).toBe(true);
    const replay = await service.handleWebhook('farmos', payload, 'evt-100');
    expect(replay.received).toBe(false);
    expect(await inbound.all()).toHaveLength(1);
    expect(await records.all()).toHaveLength(1);
    expect((await inbound.all())[0].processedAt).toBeTruthy();
  });

  it('ledgers webhook events for unknown accounts without farm-record writes', async () => {
    const { service, records, inbound } = setup();
    const result = await service.handleWebhook('farmos', {
      account_id: 'stranger',
      record_type: 'harvest',
      record_id: 'h-1'
    });
    expect(result.received).toBe(true);
    expect(await records.all()).toHaveLength(0);
    expect(await inbound.all()).toHaveLength(1);
  });

  it('recordsFor returns records across the member\'s active links', async () => {
    const { service } = setup();
    await service.syncLink('link-1');
    expect(await service.recordsFor('user-1')).toHaveLength(1);
    expect(await service.recordsFor('someone-else')).toHaveLength(0);
  });
});

describe('normalisePushedRecord', () => {
  it('maps valid payloads and rejects unmappable ones', () => {
    expect(
      normalisePushedRecord('farmos', {
        record_type: 'field_map',
        record_id: 'land-1',
        observed_at: '2026-03-01T00:00:00Z'
      })
    ).toMatchObject({ recordType: 'field_map', externalId: 'land-1', source: 'farmos' });
    expect(normalisePushedRecord('farmos', { record_type: 'expense', record_id: 'x' })).toBeUndefined();
    expect(normalisePushedRecord('farmos', { record_type: 'harvest' })).toBeUndefined();
  });
});
