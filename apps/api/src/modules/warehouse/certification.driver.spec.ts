import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  createCertificationFeed,
  HttpCertificationFeed,
  StubCertificationFeed,
  UnconfiguredCertificationFeed
} from './certification.driver.js';
import { ProviderConfigError } from '../integrations/drivers/http.js';

describe('StubCertificationFeed', () => {
  const feed = new StubCertificationFeed();

  it('is deterministic per licence reference and labelled stub', async () => {
    const first = await feed.check({ warehouseId: 'w-1', operatorLicenseRef: 'LIC-KANO-01' });
    const second = await feed.check({ warehouseId: 'w-1', operatorLicenseRef: 'LIC-KANO-01' });
    expect(first).toEqual(second);
    expect(first.basis).toBe('stub');
    expect(first.reference).toMatch(/^STUB-[0-9A-F]{12}$/);
  });

  it('falls back to the warehouse id when no licence reference is given', async () => {
    const check = await feed.check({ warehouseId: 'w-9' });
    expect(check.reference).toMatch(/^STUB-/);
    expect(['certified', 'pending', 'suspended']).toContain(check.status);
  });

  it('pins the suspended branch for suspended licence references', async () => {
    const check = await feed.check({ warehouseId: 'w-1', operatorLicenseRef: 'LIC-suspended-1' });
    expect(check.status).toBe('suspended');
  });

  it('varies outcomes across licence references (some certified)', async () => {
    const statuses = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const check = await feed.check({ warehouseId: 'w-1', operatorLicenseRef: `LIC-${i}` });
      statuses.add(check.status);
    }
    expect(statuses.has('certified')).toBe(true);
  });
});

describe('createCertificationFeed', () => {
  it('defaults to the stub driver', () => {
    expect(createCertificationFeed({})).toBeInstanceOf(StubCertificationFeed);
  });

  it('builds the live driver when fully configured', () => {
    const feed = createCertificationFeed({
      WAREHOUSE_CERTIFICATION_DRIVER: 'live',
      WAREHOUSE_CERTIFICATION_URL: 'https://operators.example.test/',
      WAREHOUSE_CERTIFICATION_API_KEY: 'key'
    });
    expect(feed).toBeInstanceOf(HttpCertificationFeed);
  });

  it('fails closed at call time outside production when live lacks config', async () => {
    const feed = createCertificationFeed({ WAREHOUSE_CERTIFICATION_DRIVER: 'live' });
    expect(feed).toBeInstanceOf(UnconfiguredCertificationFeed);
    await expect(feed.check({ warehouseId: 'w-1' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('aborts production boot when live is set without config', () => {
    expect(() =>
      createCertificationFeed({ NODE_ENV: 'production', WAREHOUSE_CERTIFICATION_DRIVER: 'live' })
    ).toThrow(ProviderConfigError);
  });
});

describe('HttpCertificationFeed (fail-closed 503 path)', () => {
  it('raises a provider error when the feed is unreachable', async () => {
    // Port 9 (discard) on loopback refuses connections deterministically.
    const feed = new HttpCertificationFeed('http://127.0.0.1:9', 'key');
    await expect(feed.check({ warehouseId: 'w-1' })).rejects.toThrow(/warehouse-certification/);
  });
});
