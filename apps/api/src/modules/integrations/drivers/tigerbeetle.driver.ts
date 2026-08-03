/**
 * TigerBeetle ledger drivers (wave FABRIC): a high-integrity transfer
 * backend behind one LedgerBackendDriver port, alongside the existing
 * Postgres double-entry ledger (LedgerService). LEGAL GATE: money movement
 * on this platform is legal-gated, so this driver defaults OFF — the stub
 * is selected unless LEDGER_DRIVER=tigerbeetle is set explicitly, and the
 * driver is NOT wired into LedgerService write paths (the Postgres ledger
 * stays the system of record). The live driver REQUIRES
 * TIGERBEETLE_ADDRESSES and TIGERBEETLE_CLUSTER_ID and fails closed:
 * ProviderConfigError at boot when either is absent, ProviderRequestError
 * (with circuit breaker) on unreachable replicas — never a silent stub
 * fallback. Amounts are integer kobo, matching the ledger invariant of no
 * floats.
 */
import { ProviderConfigError, ProviderRequestError } from './http.js';

/** DI token for the selected ledger-backend driver. */
export const LEDGER_BACKEND = Symbol('LEDGER_BACKEND');

/** Number of consecutive failures before the circuit opens. */
export const LEDGER_CIRCUIT_THRESHOLD = 3;
/** How long the circuit stays open before the next call is allowed through. */
export const LEDGER_CIRCUIT_COOLDOWN_MS = 30_000;
/** TigerBeetle ledger id used for platform transfers (1 = default). */
export const TIGERBEETLE_DEFAULT_LEDGER = 1;
/** TigerBeetle transfer code for loan disbursement-style transfers. */
export const TIGERBEETLE_DEFAULT_TRANSFER_CODE = 1;

export interface LedgerTransferInput {
  /** Caller idempotency handle (decimal string; generated when omitted). */
  transferId?: string;
  /** TigerBeetle account ids as decimal strings (u128). */
  debitAccountId: string;
  creditAccountId: string;
  /** Integer kobo — never a float. */
  amountKobo: number;
  reference: string;
}

export interface LedgerTransferResult {
  providerRef: string;
  status: 'posted' | 'failed';
  /** Honest provenance label. */
  source: string;
  detail?: string;
}

export interface LedgerBackendStatus {
  configured: boolean;
  healthy: boolean;
  detail: string;
}

export interface LedgerBackendDriver {
  readonly name: 'stub' | 'tigerbeetle';
  postTransfer(input: LedgerTransferInput): Promise<LedgerTransferResult>;
  status(): Promise<LedgerBackendStatus>;
}

/** Deterministic 32-bit FNV-1a hash so stub output is stable per input. */
function transferHash(input: LedgerTransferInput): number {
  const text = `${input.debitAccountId}:${input.creditAccountId}:${input.amountKobo}:${input.reference}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Default driver: deterministic, clearly labelled simulation. The Postgres
 * ledger (LedgerService) remains the system of record — this stub moves no
 * money and executes no transfer. Selected implicitly whenever
 * LEDGER_DRIVER is unset.
 */
export class StubLedgerBackendDriver implements LedgerBackendDriver {
  readonly name = 'stub' as const;

  postTransfer(input: LedgerTransferInput): Promise<LedgerTransferResult> {
    const hash = transferHash(input);
    return Promise.resolve({
      providerRef: `stub-tb-${hash.toString(16).padStart(8, '0')}`,
      status: 'posted',
      source:
        'stub-fixture (simulated — Postgres ledger remains the system of record; no transfer executed)',
      detail:
        'Set LEDGER_DRIVER=tigerbeetle with TIGERBEETLE_ADDRESSES and TIGERBEETLE_CLUSTER_ID to post to a TigerBeetle cluster (legal-gated).'
    });
  }

  status(): Promise<LedgerBackendStatus> {
    return Promise.resolve({
      configured: true,
      healthy: true,
      detail:
        'Stub driver: deterministic simulated transfers; Postgres ledger is the system of record. ' +
        'TigerBeetle backend is legal-gated OFF unless LEDGER_DRIVER=tigerbeetle is set.'
    });
  }
}

/** Minimal client surface (tigerbeetle-node Client subset) for lazy import + fakes. */
export interface TigerBeetleClientLike {
  createTransfers(batch: Array<Record<string, unknown>>): Promise<Array<{ index: number; result: number | string }>>;
  destroy(): void;
}

export type TigerBeetleClientFactory = () => Promise<TigerBeetleClientLike>;

/** Parses a decimal-string u128 field; throws a plain Error when invalid. */
function toU128(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `TigerBeetle ${field} must be a decimal-string u128, got '${value.slice(0, 40)}'`
    );
  }
  return BigInt(value);
}

async function defaultClientFactory(
  clusterId: string,
  addresses: string[]
): Promise<TigerBeetleClientLike> {
  const { createClient } = await import('tigerbeetle-node');
  return createClient({
    cluster_id: BigInt(clusterId),
    replica_addresses: addresses
  }) as unknown as TigerBeetleClientLike;
}

/**
 * Live TigerBeetle driver (tigerbeetle-node, lazy import). createTransfers
 * result rows map to failed transfers; transport failures trip a call-time
 * circuit breaker and surface as ProviderRequestError (callers answer
 * 503). PROOF-OF-PORT: not wired into LedgerService money movement.
 */
export class TigerBeetleLedgerBackendDriver implements LedgerBackendDriver {
  readonly name = 'tigerbeetle' as const;

  private client?: TigerBeetleClientLike;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    private readonly options: {
      clusterId: string;
      addresses: string[];
      clientFactory?: TigerBeetleClientFactory;
      ledger?: number;
      transferCode?: number;
    }
  ) {}

  async postTransfer(input: LedgerTransferInput): Promise<LedgerTransferResult> {
    // Validation happens before the circuit: malformed ids are caller
    // errors (plain Error), not broker failures, so they never trip the
    // breaker.
    const transferId = input.transferId ?? String(Date.now());
    const transfer = {
      id: toU128(transferId, 'transferId'),
      debit_account_id: toU128(input.debitAccountId, 'debitAccountId'),
      credit_account_id: toU128(input.creditAccountId, 'creditAccountId'),
      amount: toU128(String(input.amountKobo), 'amountKobo'),
      ledger: this.options.ledger ?? TIGERBEETLE_DEFAULT_LEDGER,
      code: this.options.transferCode ?? TIGERBEETLE_DEFAULT_TRANSFER_CODE,
      user_data_64: input.reference
    };
    this.assertCircuitClosed();
    try {
      const client = await this.ensureClient();
      const errors = await client.createTransfers([transfer]);
      this.recordSuccess();
      if (errors.length === 0) {
        return {
          providerRef: transferId,
          status: 'posted',
          source: 'tigerbeetle cluster (proof-of-port — not the system of record)'
        };
      }
      return {
        providerRef: transferId,
        status: 'failed',
        source: 'tigerbeetle cluster (proof-of-port — not the system of record)',
        detail: `TigerBeetle rejected the transfer: ${JSON.stringify(errors[0])}`
      };
    } catch (error) {
      this.recordFailure();
      if (error instanceof ProviderRequestError) {
        throw error;
      }
      throw new ProviderRequestError('tigerbeetle', 'network', error);
    }
  }

  status(): Promise<LedgerBackendStatus> {
    return Promise.resolve({
      configured: true,
      healthy: this.client !== undefined && !this.circuitOpen,
      detail:
        `TigerBeetle driver selected (cluster ${this.options.clusterId}, replicas ${this.options.addresses.join(', ')}). ` +
        'PROOF-OF-PORT: not wired into LedgerService money movement (legal gate); connects on first transfer.'
    });
  }

  /** Visible for tests: whether the circuit breaker is currently open. */
  get circuitOpen(): boolean {
    return (
      this.consecutiveFailures >= LEDGER_CIRCUIT_THRESHOLD &&
      Date.now() < this.circuitOpenUntil
    );
  }

  private async ensureClient(): Promise<TigerBeetleClientLike> {
    if (!this.client) {
      const factory =
        this.options.clientFactory ??
        (() => defaultClientFactory(this.options.clusterId, this.options.addresses));
      this.client = await factory();
    }
    return this.client;
  }

  private assertCircuitClosed(): void {
    if (this.circuitOpen) {
      throw new ProviderRequestError(
        'tigerbeetle',
        'network',
        new Error(
          `circuit open after ${this.consecutiveFailures} consecutive failures; retry after cooldown`
        )
      );
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= LEDGER_CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + LEDGER_CIRCUIT_COOLDOWN_MS;
    }
  }
}

export { ProviderConfigError, ProviderRequestError };

/**
 * Builds the configured driver. Default is the stub (legal-gated OFF —
 * Postgres ledger stays authoritative); LEDGER_DRIVER=tigerbeetle requires
 * TIGERBEETLE_ADDRESSES (comma-separated host:port list) and
 * TIGERBEETLE_CLUSTER_ID, failing closed with ProviderConfigError
 * otherwise.
 */
export function createLedgerBackendDriver(
  env: NodeJS.ProcessEnv = process.env
): LedgerBackendDriver {
  const flag = (env.LEDGER_DRIVER ?? 'stub').toLowerCase();
  if (flag === 'tigerbeetle') {
    const missing = ['TIGERBEETLE_ADDRESSES', 'TIGERBEETLE_CLUSTER_ID'].filter(
      (name) => !env[name]
    );
    if (missing.length > 0) {
      throw new ProviderConfigError('tigerbeetle', missing);
    }
    const addresses = (env.TIGERBEETLE_ADDRESSES as string)
      .split(',')
      .map((address) => address.trim())
      .filter((address) => address.length > 0);
    if (addresses.length === 0) {
      throw new ProviderConfigError('tigerbeetle', ['TIGERBEETLE_ADDRESSES']);
    }
    return new TigerBeetleLedgerBackendDriver({
      clusterId: env.TIGERBEETLE_CLUSTER_ID as string,
      addresses
    });
  }
  return new StubLedgerBackendDriver();
}
