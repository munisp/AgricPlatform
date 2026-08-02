import { describe, expect, it } from 'vitest';
import { allEndpoints, OPENAPI_CATALOGUE } from '@/lib/openapi-catalogue';

describe('developer portal endpoint catalogue', () => {
  it('documents every wave-P5d surface area', () => {
    const sectionIds = OPENAPI_CATALOGUE.map((section) => section.id);
    expect(sectionIds).toEqual([
      'authentication',
      'partner-reads',
      'partner-writes',
      'webhooks',
      'embeds'
    ]);
  });

  it('has unique method+path pairs', () => {
    const keys = allEndpoints().map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('declares scopes on every scoped partner route', () => {
    const scoped = allEndpoints().filter(
      (endpoint) =>
        endpoint.path.startsWith('/api/v1/partner/') &&
        !endpoint.path.includes('oauth/token') &&
        !endpoint.path.includes('developer-keys')
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const endpoint of scoped) {
      expect(endpoint.scopes?.length, endpoint.path).toBeGreaterThan(0);
    }
  });

  it('documents the four anonymous embed feeds', () => {
    const embeds = allEndpoints().filter((endpoint) => endpoint.path.startsWith('/api/v1/embed/'));
    expect(embeds.map((endpoint) => endpoint.path)).toEqual([
      '/api/v1/embed/opportunities',
      '/api/v1/embed/prices',
      '/api/v1/embed/courses',
      '/api/v1/embed/member-cta'
    ]);
    for (const endpoint of embeds) {
      expect(endpoint.auth).toBe('none');
    }
  });

  it('documents the client-credentials token endpoint', () => {
    const token = allEndpoints().find((endpoint) => endpoint.path.includes('oauth/token'));
    expect(token).toBeDefined();
    expect(token?.method).toBe('POST');
    expect(token?.auth).toBe('none');
  });
});
