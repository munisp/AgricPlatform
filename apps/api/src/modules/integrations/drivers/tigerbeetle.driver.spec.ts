import { describe, expect, it, vi } from 'vitest';
import { ProviderConfigError, ProviderRequestError } from './http.js';
import {
  createLedgerBackendDriver,
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
