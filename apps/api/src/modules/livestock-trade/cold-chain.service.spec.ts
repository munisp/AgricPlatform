import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AggregationPoint, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryAggregationPointRepository,
  createInMemoryColdChainLogRepository
} from '../../database/repositories/livestock-trade.repository.js';
import { FailClosedColdChainProvider, ProviderNotConfiguredError } from './provider-stubs.js';
import { ColdChainService } from './cold-chain.service.js';

const asUser = (id: string, roles: string[]): User => ({ id, roles }) as unknown as User;

const manager = asUser('partner-1', ['partner']);
const outsider = asUser('partner-2', ['partner']);

const point: AggregationPoint = {
  id: 'point-1',
  name: 'Zaria cold hub',
  state: 'Kaduna',
  lga: 'Zaria',
  managerUserId: manager.id,
  lotIds: [],
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

const reading = {
  recordedAt: '2026-02-01T08:00:00.000Z',
  temperatureCelsius: 3.5,
  humidityPercent: 62
};

describe('ColdChainService', () => {
  let points: ReturnType<typeof createInMemoryAggregationPointRepository>;
  let logs: ReturnType<typeof createInMemoryColdChainLogRepository>;
  let outbox: ReturnType<typeof createInMemoryOutboxRepository>;
  let provider: { provider: string; submitReading: ReturnType<typeof vi.fn> };
  let service: ColdChainService;

  beforeEach(() => {
    points = createInMemoryAggregationPointRepository([point]);
    logs = createInMemoryColdChainLogRepository();
    outbox = createInMemoryOutboxRepository();
    provider = {
      provider: 'fake-telemetry',
      submitReading: vi.fn().mockResolvedValue({ providerRef: 'tlm-1' })
    };
    service = new ColdChainService(
      new DomainEventsService(outbox),
      points,
      logs,
      provider
    );
  });

  it('ingests a validated reading through the provider and stores the log', async () => {
    const log = await service.ingest(manager, point.id, reading);
    expect(log.source).toBe('fake-telemetry');
    expect(log.temperatureCelsius).toBe(3.5);
    expect(provider.submitReading).toHaveBeenCalledWith({ pointId: point.id, ...reading });
    const events = await outbox.list();
    expect(events.map((event) => event.name)).toContain(
      'livestock_trade.cold_chain.reading_ingested'
    );
  });

  it('fails closed with the default stub: no ingestion, no stored log', async () => {
    const closed = new ColdChainService(
      new DomainEventsService(outbox),
      points,
      logs,
      new FailClosedColdChainProvider()
    );
    await expect(closed.ingest(manager, point.id, reading)).rejects.toThrow(
      ProviderNotConfiguredError
    );
    expect(await logs.find({ pointId: point.id })).toHaveLength(0);
  });

  it('validates timestamps, temperature and humidity', async () => {
    await expect(
      service.ingest(manager, point.id, { ...reading, recordedAt: 'not-a-date' })
    ).rejects.toThrow('recordedAt');
    await expect(
      service.ingest(manager, point.id, { ...reading, temperatureCelsius: Number.NaN })
    ).rejects.toThrow('temperatureCelsius');
    await expect(
      service.ingest(manager, point.id, { ...reading, humidityPercent: 120 })
    ).rejects.toThrow('humidityPercent');
  });

  it('restricts ingestion and log reads to the point manager or admin', async () => {
    await expect(service.ingest(outsider, point.id, reading)).rejects.toThrow(
      'You may only access your own records'
    );
    await service.ingest(manager, point.id, reading);
    await expect(service.listLogs(outsider, point.id)).rejects.toThrow(
      'You may only access your own records'
    );
    expect(await service.listLogs(manager, point.id)).toHaveLength(1);
  });

  it('returns logs ordered by recordedAt', async () => {
    await service.ingest(manager, point.id, {
      ...reading,
      recordedAt: '2026-02-03T08:00:00.000Z'
    });
    await service.ingest(manager, point.id, reading);
    const stored = await service.listLogs(manager, point.id);
    expect(stored.map((log) => log.recordedAt)).toEqual([
      '2026-02-01T08:00:00.000Z',
      '2026-02-03T08:00:00.000Z'
    ]);
  });
});
