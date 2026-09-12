import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError
} from '../integrations/drivers/http.js';
import { mapSearchProviderFailure, SearchController } from './search.controller.js';
import type { SearchProvider } from './search.provider.js';

/**
 * WP-G10: search backend failures (OpenSearch and Meilisearch alike — both
 * sit behind the SEARCH_PROVIDER port) must surface as 503
 * ServiceUnavailable, never 500 Internal Server Error.
 */
function providerThrowing(error: unknown): SearchProvider {
  return {
    search: vi.fn().mockRejectedValue(error),
    suggest: vi.fn().mockRejectedValue(error),
    trending: vi.fn().mockRejectedValue(error),
    related: vi.fn().mockRejectedValue(error)
  };
}

describe('mapSearchProviderFailure (503-not-500 doctrine)', () => {
  it('maps ProviderRequestError (timeout/network/circuit-open) to 503', () => {
    for (const error of [
      new ProviderRequestError('opensearch', 'timeout'),
      new ProviderRequestError('opensearch', 'network', new Error('circuit open')),
      new ProviderRequestError('meilisearch', 'network', new TypeError('ECONNREFUSED'))
    ]) {
      try {
        mapSearchProviderFailure(error);
        expect.unreachable('must throw');
      } catch (thrown) {
        expect(thrown).toBeInstanceOf(ServiceUnavailableException);
        expect((thrown as ServiceUnavailableException).getStatus()).toBe(503);
      }
    }
  });

  it('maps ProviderHttpError (non-2xx backend response) to 503', () => {
    expect(() => mapSearchProviderFailure(new ProviderHttpError('opensearch', 502, 'bad gateway')))
      .toThrow(ServiceUnavailableException);
  });

  it('maps ProviderConfigError (misconfigured live driver) to 503', () => {
    expect(() => mapSearchProviderFailure(new ProviderConfigError('search', ['SEARCH_DRIVER'])))
      .toThrow(ServiceUnavailableException);
  });

  it('rethrows non-provider errors unchanged (they stay 500-class bugs)', () => {
    const bug = new Error('repository exploded');
    expect(() => mapSearchProviderFailure(bug)).toThrow(bug);
    expect(() => mapSearchProviderFailure(bug)).not.toThrow(ServiceUnavailableException);
  });

  it('does not relay provider error bodies to the client (A3-7)', () => {
    try {
      mapSearchProviderFailure(new ProviderHttpError('meilisearch', 500, 'secret-index-detail'));
      expect.unreachable('must throw');
    } catch (thrown) {
      expect((thrown as ServiceUnavailableException).message).not.toContain('secret-index-detail');
    }
  });
});

describe('SearchController provider failure mapping', () => {
  it('search answers 503 when the OpenSearch driver times out', async () => {
    const controller = new SearchController(
      providerThrowing(new ProviderRequestError('opensearch', 'timeout'))
    );
    const failure = await controller
      .search({ q: 'maize' } as never)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect((failure as ServiceUnavailableException).getStatus()).toBe(503);
  });

  it('suggest answers 503 when the Meilisearch driver fails', async () => {
    const controller = new SearchController(
      providerThrowing(new ProviderRequestError('meilisearch', 'network'))
    );
    const failure = await controller.suggest('maize').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
  });

  it('related keeps non-provider errors as-is', async () => {
    const bug = new Error('repository exploded');
    const controller = new SearchController(providerThrowing(bug));
    const failure = await controller
      .related({ type: 'course', id: 'c1' } as never)
      .catch((error: unknown) => error);
    expect(failure).toBe(bug);
  });
});

describe('SearchController driver-status (WP-G10, admin diagnostics)', () => {
  it('reports the in-process fan-out honestly when no live driver is selected', async () => {
    const inProcess: SearchProvider = {
      search: vi.fn(),
      suggest: vi.fn(),
      trending: vi.fn(),
      related: vi.fn()
      // no status(): the in-process SearchService has no external backend
    };
    const controller = new SearchController(inProcess);
    const { data } = (await controller.driverStatus()) as { data: Record<string, unknown> };
    expect(data.driver).toBe('in-process');
    expect(data.healthy).toBe(true);
    expect(String(data.detail)).toContain('no external search driver');
  });

  it('exposes the live driver status when the provider implements status()', async () => {
    const live: SearchProvider & { name: string } = {
      name: 'opensearch',
      search: vi.fn(),
      suggest: vi.fn(),
      trending: vi.fn(),
      related: vi.fn(),
      status: vi.fn().mockResolvedValue({
        configured: true,
        healthy: true,
        circuitBreaker: 'closed',
        lastErrorClass: null,
        lastSuccessAt: '2026-09-27T00:00:00.000Z',
        detail: 'OpenSearch client created for index agric-platform.'
      })
    };
    const controller = new SearchController(live);
    const { data } = (await controller.driverStatus()) as { data: Record<string, unknown> };
    expect(data.driver).toBe('opensearch');
    expect(data.circuitBreaker).toBe('closed');
    expect(data.lastSuccessAt).toBe('2026-09-27T00:00:00.000Z');
  });
});
