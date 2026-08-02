import { describe, expect, it } from 'vitest';
import { InMemoryAdvisoryRepository } from '../../../database/repositories/advisory.repository.js';
import type { ExtensionFeedSource } from '../drivers/extension-feeds.drivers.js';
import { ExtensionAdvisoryService } from './extension-advisory.service.js';

const fakeSource = (name: string): ExtensionFeedSource => ({
  name,
  fetchLatest: async () => [
    {
      externalId: 'b-1',
      kind: 'pest_alert',
      title: 'Fall armyworm outbreak',
      summary: 'Scout maize fields weekly',
      state: 'Kaduna',
      crop: 'Maize',
      severity: 'critical',
      publishedAt: '2026-05-01T08:00:00.000Z',
      source: 'NAERLS'
    }
  ]
});

describe('ExtensionAdvisoryService', () => {
  it('stays disabled without the live flag and credentials', () => {
    const service = new ExtensionAdvisoryService(new InMemoryAdvisoryRepository(), [fakeSource('naerls')], {});
    expect(service.enabled).toBe(false);
    service.onModuleInit();
    service.onModuleDestroy();
  });

  it('is enabled with EXTENSION_FEED_DRIVER=live and a keyed source', () => {
    const service = new ExtensionAdvisoryService(new InMemoryAdvisoryRepository(), [fakeSource('naerls')], {
      EXTENSION_FEED_DRIVER: 'live',
      NAERLS_BASE_URL: 'https://n.example',
      NAERLS_API_KEY: 'k'
    });
    expect(service.enabled).toBe(true);
  });

  it('maps bulletins into source+region tagged advisory items (replay-safe)', async () => {
    const repo = new InMemoryAdvisoryRepository([]);
    const service = new ExtensionAdvisoryService(repo, [fakeSource('naerls')], {
      EXTENSION_FEED_DRIVER: 'live',
      NAERLS_BASE_URL: 'https://n.example',
      NAERLS_API_KEY: 'k'
    });
    expect(await service.ingestOnce()).toBe(1);
    expect(await service.ingestOnce()).toBe(0); // deterministic ids dedupe reruns
    const items = await repo.all();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'ext-naerls-b-1',
      kind: 'pest_alert',
      title: '[NAERLS] Fall armyworm outbreak',
      state: 'Kaduna',
      severity: 'critical'
    });
  });
});
