import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import {
  createEscrowPayoutDriver,
  LiveEscrowPayoutDriver,
  StubEscrowPayoutDriver,
  type EscrowPayoutCommand
} from './payout.driver.js';

// Low-entropy, obviously-fake dummy credentials (never real secrets; the live
// driver only needs them to pass the weak-credential refusal).
const DUMMY_URL = 'https://payout-provider.example.invalid';
const DUMMY_KEY = 'dummy-payout-api-key-0000';
const DUMMY_SECRET = 'dummy-payout-signing-secret-0000';

const command: EscrowPayoutCommand = {
  escrowId: 'escrow-1',
  orderId: 'order-1',
  kind: 'release',
  amountKobo: 37_000_000,
  idempotencyKey: 'escrow-payout:release:escrow-1'
};

describe('escrow payout driver factory (Stage 23)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('defaults to the labelled stub outside production', () => {
    const driver = createEscrowPayoutDriver({});
    expect(driver).toBeInstanceOf(StubEscrowPayoutDriver);
    expect(driver.name).toBe('stub');
  });

  it('the stub succeeds locally with a deterministic, labelled reference', async () => {
    const driver = createEscrowPayoutDriver({ ESCROW_PAYOUT_DRIVER: 'stub' });
    const first = await driver.payout(command);
    const second = await driver.payout(command);
    expect(first.basis).toBe('stub');
    expect(first.providerReference).toContain(command.idempotencyKey);
    expect(second).toEqual(first); // idempotent per idempotency key
  });

  it('never throws at resolution time in production when stub/unset (fail closed is lazy)', () => {
    process.env.NODE_ENV = 'production';
    // Boot stays up (CI smoke env); EscrowService refuses money-out at
    // use-time instead — see escrow.service.spec.ts.
    expect(createEscrowPayoutDriver({}).name).toBe('stub');
    expect(createEscrowPayoutDriver({ ESCROW_PAYOUT_DRIVER: 'stub' }).name).toBe('stub');
  });

  it('live without provider config is a config error (fail closed)', () => {
    expect(() => createEscrowPayoutDriver({ ESCROW_PAYOUT_DRIVER: 'live' })).toThrow(
      ProviderConfigError
    );
    expect(() =>
      createEscrowPayoutDriver({ ESCROW_PAYOUT_DRIVER: 'live', PAYOUT_PROVIDER_URL: DUMMY_URL })
    ).toThrow(/PAYOUT_PROVIDER_API_KEY/);
  });

  it('live rejects published/default/short secrets', () => {
    for (const weak of ['secret', 'changeme', 'short']) {
      expect(() =>
        createEscrowPayoutDriver({
          ESCROW_PAYOUT_DRIVER: 'live',
          PAYOUT_PROVIDER_URL: DUMMY_URL,
          PAYOUT_PROVIDER_API_KEY: DUMMY_KEY,
          PAYOUT_PROVIDER_SIGNING_SECRET: weak
        })
      ).toThrow(ProviderConfigError);
    }
  });

  it('live with full config resolves but every payout answers 503 not-integrated', async () => {
    process.env.NODE_ENV = 'production';
    const driver = createEscrowPayoutDriver({
      ESCROW_PAYOUT_DRIVER: 'live',
      PAYOUT_PROVIDER_URL: DUMMY_URL,
      PAYOUT_PROVIDER_API_KEY: DUMMY_KEY,
      PAYOUT_PROVIDER_SIGNING_SECRET: DUMMY_SECRET
    });
    expect(driver).toBeInstanceOf(LiveEscrowPayoutDriver);
    expect(driver.name).toBe('live');
    await expect(driver.payout(command)).rejects.toThrowError(ServiceUnavailableException);
    await expect(driver.payout(command)).rejects.toThrowError(/not yet integrated/);
  });
});
