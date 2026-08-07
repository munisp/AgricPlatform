import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  createCollateralRegistry,
  HttpCollateralRegistry,
  StubCollateralRegistry,
  UnconfiguredCollateralRegistry
} from './collateral-registry.driver.js';
import { ProviderConfigError } from '../integrations/drivers/http.js';

const INPUT = {
  pledgeId: 'whpledge-1',
  receiptId: 'whr-1',
  receiptNumber: 'WHR-2026-ABCDEF12',
  lenderId: 'user-lender',
  borrowerId: 'user-farmer',
  principalKobo: 5_000_000
};

describe('StubCollateralRegistry', () => {
  const registry = new StubCollateralRegistry();

  it('returns a deterministic STUB-labelled reference', async () => {
    const first = await registry.register(INPUT);
    const second = await registry.register(INPUT);
    expect(first).toEqual(second);
    expect(first.basis).toBe('stub');
    expect(first.reference).toMatch(/^STUB-[0-9A-F]{12}$/);
  });

  it('varies the reference per pledge', async () => {
    const other = await registry.register({ ...INPUT, pledgeId: 'whpledge-2' });
    const first = await registry.register(INPUT);
    expect(other.reference).not.toBe(first.reference);
  });

  it('release is a no-op that resolves', async () => {
    await expect(registry.release('STUB-ABCDEF123456')).resolves.toBeUndefined();
  });
});

describe('createCollateralRegistry', () => {
  it('defaults to the stub driver', () => {
    expect(createCollateralRegistry({})).toBeInstanceOf(StubCollateralRegistry);
  });

  it('builds the live driver when fully configured', () => {
    const registry = createCollateralRegistry({
      COLLATERAL_REGISTRY_DRIVER: 'live',
      COLLATERAL_REGISTRY_URL: 'https://registry.example.test',
      COLLATERAL_REGISTRY_API_KEY: 'key'
    });
    expect(registry).toBeInstanceOf(HttpCollateralRegistry);
  });

  it('fails closed at call time outside production when live lacks config', async () => {
    const registry = createCollateralRegistry({ COLLATERAL_REGISTRY_DRIVER: 'live' });
    expect(registry).toBeInstanceOf(UnconfiguredCollateralRegistry);
    await expect(registry.register(INPUT)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(registry.release('STUB-X')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('aborts production boot when live is set without config', () => {
    expect(() =>
      createCollateralRegistry({ NODE_ENV: 'production', COLLATERAL_REGISTRY_DRIVER: 'live' })
    ).toThrow(ProviderConfigError);
  });
});

describe('HttpCollateralRegistry (fail-closed 503 path)', () => {
  it('raises a provider error when the registry is unreachable', async () => {
    const registry = new HttpCollateralRegistry('http://127.0.0.1:9', 'key');
    await expect(registry.register(INPUT)).rejects.toThrow(/collateral-registry/);
  });

  it('raises a provider error on release when unreachable', async () => {
    const registry = new HttpCollateralRegistry('http://127.0.0.1:9', 'key');
    await expect(registry.release('STUB-ABCDEF123456')).rejects.toThrow(/collateral-registry/);
  });
});
