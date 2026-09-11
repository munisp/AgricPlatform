import { describe, expect, it, vi } from 'vitest';
import type { TelemetryService } from '../../../common/telemetry/telemetry.service.js';
import { ProviderConfigError, ProviderRequestError } from './http.js';
import {
  createLedgerBackendDriver,
  generateTransferId,
  LEDGER_CIRCUIT_THRESHOLD,
  StubLedgerBackendDriver,
  TigerBeetleLedgerBackendDriver,
  type LedgerTransferInput,
  type TigerBeetleClientLike
} from './tigerbeetle.driver.js';

const TRANSFER: LedgerTransferInput = {
  transferId: '1001',
  debitAccountId: '2001',
  creditAccountId: '2002',
  amountKobo: 500_000,
  reference: 'loan-1'
};

describe('StubLedgerBackendDriver (default — Postgres ledger authoritative)', () => {
  const driver = new StubLedgerBackendDriver();

  it('is deterministic per transfer input', async () => {
    const a = await driver.postTransfer(TRANSFER);
    const b = await driver.postTransfer({ ...TRANSFER });
    expect(a).toEqual(b);
    expect(a.providerRef).toMatch(/^stub-tb-[0-9a-f]{8}$/);
  });

  it('labels the result as simulated with no money moved', async () => {
    const result = await driver.postTransfer(TRANSFER);
    expect(result.source).toContain('stub-fixture');
    expect(result.source).toContain('no transfer executed');
    const status = await driver.status();
    expect(status.detail).toContain('legal-gated OFF');
  });
});

describe('createLedgerBackendDriver selection (legal gate: defaults OFF)', () => {
  it('defaults to the stub when LEDGER_DRIVER is unset', () => {
    expect(createLedgerBackendDriver({}).name).toBe('stub');
  });

  it('fails closed when tigerbeetle is selected without its envs', () => {
    expect(() => createLedgerBackendDriver({ LEDGER_DRIVER: 'tigerbeetle' })).toThrow(
      ProviderConfigError
    );
    expect(() =>
      createLedgerBackendDriver({
        LEDGER_DRIVER: 'tigerbeetle',
        TIGERBEETLE_ADDRESSES: 'localhost:3000'
      })
    ).toThrow(ProviderConfigError);
    try {
      createLedgerBackendDriver({ LEDGER_DRIVER: 'tigerbeetle' });
      expect.unreachable();
    } catch (error) {
      expect((error as ProviderConfigError).missing).toEqual([
        'TIGERBEETLE_ADDRESSES',
        'TIGERBEETLE_CLUSTER_ID'
      ]);
    }
  });

  it('builds the tigerbeetle driver when both envs are present', () => {
    const driver = createLedgerBackendDriver({
      LEDGER_DRIVER: 'tigerbeetle',
      TIGERBEETLE_ADDRESSES: 'localhost:3000',
      TIGERBEETLE_CLUSTER_ID: '0'
    });
    expect(driver.name).toBe('tigerbeetle');
  });
});

describe('TigerBeetleLedgerBackendDriver', () => {
  function fakeClient(errors: Array<{ index: number; result: string }> = []) {
    const client: TigerBeetleClientLike = {
      createTransfers: vi.fn().mockResolvedValue(errors),
      destroy: vi.fn()
    };
    return client;
  }

  it('posts a transfer with u128 ids and integer kobo amount', async () => {
    const client = fakeClient();
    const driver = new TigerBeetleLedgerBackendDriver({
      clusterId: '0',
      addresses: ['localhost:3000'],
      clientFactory: () => Promise.resolve(client)
    });
    const result = await driver.postTransfer(TRANSFER);
    expect(result.status).toBe('posted');
    expect(result.providerRef).toBe('1001');
    const batch = (client.createTransfers as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Array<Record<string, unknown>>;
    expect(batch[0].id).toBe(1001n);
    expect(batch[0].debit_account_id).toBe(2001n);
    expect(batch[0].credit_account_id).toBe(2002n);
    expect(batch[0].amount).toBe(500_000n);
  });

  it('reports failed when TigerBeetle rejects the transfer', async () => {
    const client = fakeClient([{ index: 0, result: 'exists' }]);
    const driver = new TigerBeetleLedgerBackendDriver({
      clusterId: '0',
      addresses: ['localhost:3000'],
      clientFactory: () => Promise.resolve(client)
    });
    const result = await driver.postTransfer(TRANSFER);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('exists');
  });

  it('rejects malformed ids as caller errors (never trips the circuit)', async () => {
    const client = fakeClient();
    const driver = new TigerBeetleLedgerBackendDriver({
      clusterId: '0',
      addresses: ['localhost:3000'],
      clientFactory: () => Promise.resolve(client)
    });
    await expect(
      driver.postTransfer({ ...TRANSFER, debitAccountId: 'not-a-number' })
    ).rejects.toThrow(/decimal-string u128/);
    expect(client.createTransfers).not.toHaveBeenCalled();
    expect(driver.circuitOpen).toBe(false);
  });

  it('opens the circuit after consecutive transport failures and fails fast', async () => {
    const client: TigerBeetleClientLike = {
      createTransfers: vi.fn().mockRejectedValue(new Error('replica unreachable')),
      destroy: vi.fn()
    };
    const driver = new TigerBeetleLedgerBackendDriver({
      clusterId: '0',
      addresses: ['localhost:3000'],
      clientFactory: () => Promise.resolve(client)
    });
    for (let i = 0; i < LEDGER_CIRCUIT_THRESHOLD; i += 1) {
      await expect(driver.postTransfer(TRANSFER)).rejects.toBeInstanceOf(ProviderRequestError);
    }
    expect(driver.circuitOpen).toBe(true);
    const callsBefore = (client.createTransfers as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(driver.postTransfer(TRANSFER)).rejects.toBeInstanceOf(ProviderRequestError);
    expect((client.createTransfers as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsBefore
    );
  });
});

/** Records TelemetryService calls; withSpan executes fn like the real thing. */
function fakeTelemetry() {
  return {
    withSpan: vi.fn((_name: string, _attrs: unknown, fn: () => unknown) => fn()),
    increment: vi.fn(),
    record: vi.fn()
  };
}

describe('TigerBeetleLedgerBackendDriver telemetry (Stage 25.2)', () => {
  function fakeClient(errors: Array<{ index: number; result: string }> = []) {
    const client: TigerBeetleClientLike = {
      createTransfers: vi.fn().mockResolvedValue(errors),
      destroy: vi.fn()
    };
    return client;
  }

  function driverWith(telemetry: ReturnType<typeof fakeTelemetry>, client: TigerBeetleClientLike) {
    return new TigerBeetleLedgerBackendDriver({
      clusterId: '0',
      addresses: ['localhost:3000'],
      clientFactory: () => Promise.resolve(client),
      telemetry: telemetry as unknown as TelemetryService
    });
  }

  it('wraps createTransfers in a span with operation/ledger/transfer-count attrs', async () => {
    const telemetry = fakeTelemetry();
    const driver = driverWith(telemetry, fakeClient());
    await driver.postTransfer(TRANSFER);
    expect(telemetry.withSpan).toHaveBeenCalledWith(
      'tigerbeetle.create_transfers',
      expect.objectContaining({
        'tb.operation': 'create_transfers',
        'tb.ledger': 1,
        'tb.transfer_count': 1
      }),
      expect.any(Function)
    );
    // No account ids / references (financial PII) in span attributes.
    const attrs = telemetry.withSpan.mock.calls[0][1] as Record<string, unknown>;
    expect(JSON.stringify(attrs)).not.toContain('2001');
    expect(JSON.stringify(attrs)).not.toContain('loan-1');
  });

  it('records the operation duration histogram on success', async () => {
    const telemetry = fakeTelemetry();
    const driver = driverWith(telemetry, fakeClient());
    await driver.postTransfer(TRANSFER);
    expect(telemetry.record).toHaveBeenCalledWith(
      'tigerbeetle.operation.duration',
      expect.any(Number),
      expect.objectContaining({ 'tb.operation': 'create_transfers' })
    );
  });

  it('counts TigerBeetle-level rejections separately from transport errors', async () => {
    const telemetry = fakeTelemetry();
    const driver = driverWith(telemetry, fakeClient([{ index: 0, result: 'exists' }]));
    const result = await driver.postTransfer(TRANSFER);
    expect(result.status).toBe('failed');
    expect(telemetry.increment).toHaveBeenCalledWith(
      'tigerbeetle.transfer.rejected',
      1,
      expect.objectContaining({ 'tb.operation': 'create_transfers' })
    );
    expect(telemetry.increment).not.toHaveBeenCalledWith(
      'tigerbeetle.operation.errors',
      expect.anything(),
      expect.anything()
    );
  });

  it('counts transport failures on the error counter and still throws', async () => {
    const telemetry = fakeTelemetry();
    const client: TigerBeetleClientLike = {
      createTransfers: vi.fn().mockRejectedValue(new Error('replica unreachable')),
      destroy: vi.fn()
    };
    const driver = driverWith(telemetry, client);
    await expect(driver.postTransfer(TRANSFER)).rejects.toBeInstanceOf(ProviderRequestError);
    expect(telemetry.increment).toHaveBeenCalledWith(
      'tigerbeetle.operation.errors',
      1,
      expect.objectContaining({ 'tb.operation': 'create_transfers' })
    );
    expect(telemetry.record).toHaveBeenCalledWith(
      'tigerbeetle.operation.duration',
      expect.any(Number),
      expect.anything()
    );
  });

  it('keeps caller errors (malformed ids) out of spans and counters', async () => {
    const telemetry = fakeTelemetry();
    const driver = driverWith(telemetry, fakeClient());
    await expect(
      driver.postTransfer({ ...TRANSFER, debitAccountId: 'not-a-number' })
    ).rejects.toThrow(/decimal-string u128/);
    expect(telemetry.withSpan).not.toHaveBeenCalled();
    expect(telemetry.increment).not.toHaveBeenCalled();
  });

  it('is no-op-safe without an injected TelemetryService (default fallback)', async () => {
    const driver = new TigerBeetleLedgerBackendDriver({
      clusterId: '0',
      addresses: ['localhost:3000'],
      clientFactory: () => Promise.resolve(fakeClient())
    });
    await expect(driver.postTransfer(TRANSFER)).resolves.toMatchObject({ status: 'posted' });
  });
});


/* ------------------------------------------------------------------------
 * WP-G13 (Stage 27, ledger hardening): collision-resistant transfer ids.
 * TigerBeetle deduplicates transfers by id — a reused id silently replays
 * the FIRST transfer — so Date.now()/Math.random-derived ids are a silent
 * money-corruption hazard. The driver must hard-fail them.
 * ---------------------------------------------------------------------- */
describe('TigerBeetle transferId guard (WP-G13)', () => {
  function fakeClient(errors: Array<{ index: number; result: string }> = []) {
    const client: TigerBeetleClientLike = {
      createTransfers: vi.fn().mockResolvedValue(errors),
      lookupAccounts: vi.fn().mockResolvedValue([]),
      destroy: vi.fn()
    };
    return client;
  }

  function driverWith(client: TigerBeetleClientLike): TigerBeetleLedgerBackendDriver {
    return new TigerBeetleLedgerBackendDriver({
      clusterId: '0',
      addresses: ['localhost:3000'],
      clientFactory: () => Promise.resolve(client)
    });
  }

  it('hard-fails a supplied id that looks like Date.now() epoch millis — client never called', async () => {
    const client = fakeClient();
    const driver = driverWith(client);
    await expect(
      driver.postTransfer({ ...TRANSFER, transferId: String(Date.now()) })
    ).rejects.toThrow(/epoch-millis/);
    expect(client.createTransfers).not.toHaveBeenCalled();
    expect(driver.circuitOpen).toBe(false); // caller bug, not a broker failure
  });

  it('hard-fails the zero id (TigerBeetle null id)', async () => {
    const client = fakeClient();
    await expect(
      driverWith(client).postTransfer({ ...TRANSFER, transferId: '0' })
    ).rejects.toThrow(/non-zero/);
    expect(client.createTransfers).not.toHaveBeenCalled();
  });

  it('generates a collision-resistant UUIDv7-based u128 when transferId is omitted', async () => {
    const client = fakeClient();
    const driver = driverWith(client);
    const first = await driver.postTransfer({ ...TRANSFER, transferId: undefined });
    const second = await driver.postTransfer({ ...TRANSFER, transferId: undefined });
    expect(first.status).toBe('posted');
    expect(second.status).toBe('posted');
    // Distinct ids even within the same millisecond (74 random bits), and
    // both are valid non-zero u128 decimals far above the epoch-millis range.
    expect(first.providerRef).not.toBe(second.providerRef);
    for (const ref of [first.providerRef, second.providerRef]) {
      expect(/^[0-9]+$/.test(ref)).toBe(true);
      const value = BigInt(ref);
      expect(value > 10_000_000_000_000n).toBe(true);
      expect(value < 2n ** 128n).toBe(true);
    }
    const batch = (client.createTransfers as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<
      Record<string, unknown>
    >;
    expect(batch[0].id).toBe(BigInt(first.providerRef));
  });

  it('accepts caller-managed small ids and hash-derived ids (outside the lookalike range)', async () => {
    const client = fakeClient();
    const driver = driverWith(client);
    await expect(
      driver.postTransfer({ ...TRANSFER, transferId: '42' })
    ).resolves.toMatchObject({ status: 'posted', providerRef: '42' });
    // A u128 with the high bit set (e.g. UUID-derived) is far above the range.
    const uuidDerived = BigInt('0xf47ac10b58cc4372a5670e02b2c3d479').toString(10);
    await expect(
      driver.postTransfer({ ...TRANSFER, transferId: uuidDerived })
    ).resolves.toMatchObject({ status: 'posted' });
  });

  it('generateTransferId is time-ordered on the 48-bit ms prefix', async () => {
    const earlier = BigInt(generateTransferId(1_000_000));
    const later = BigInt(generateTransferId(2_000_000));
    expect(later > earlier).toBe(true);
  });

  it('lookupAccountBalances returns posted balances aligned with the request (sparse)', async () => {
    const client: TigerBeetleClientLike = {
      createTransfers: vi.fn(),
      lookupAccounts: vi
        .fn()
        .mockResolvedValue([{ id: 7001n, debits_posted: 1_000n, credits_posted: 400n }]),
      destroy: vi.fn()
    };
    const driver = driverWith(client);
    const balances = await driver.lookupAccountBalances(['7001', '7002']);
    expect(client.lookupAccounts).toHaveBeenCalledWith([7001n, 7002n]);
    expect(balances).toEqual([
      { accountId: '7001', debitsPostedKobo: 1_000, creditsPostedKobo: 400 },
      undefined // TigerBeetle omits unknown accounts
    ]);
  });

  it('lookupAccountBalances fails visible when the client cannot look accounts up', async () => {
    const driver = driverWith(fakeClientNoLookup());
    await expect(driver.lookupAccountBalances(['7001'])).rejects.toBeInstanceOf(
      ProviderRequestError
    );
  });
});

function fakeClientNoLookup(): TigerBeetleClientLike {
  return { createTransfers: vi.fn(), destroy: vi.fn() };
}
