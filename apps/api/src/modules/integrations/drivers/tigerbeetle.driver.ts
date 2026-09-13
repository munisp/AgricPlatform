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
import { randomBytes } from 'node:crypto';
import { TelemetryService } from '../../../common/telemetry/telemetry.service.js';
import {
  circuitBreakerState,
  DriverHealthTracker,
  type DriverHealthFields
} from './driver-health.js';
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
  /**
   * Caller idempotency handle (decimal-string u128). WP-G13: must be
   * collision-resistant — derive it from a UUIDv7/ULID or the caller's
   * idempotency key. Values that look like a raw Date.now() epoch-millis
   * timestamp HARD-FAIL (see assertCollisionResistantTransferId). When
   * omitted the driver generates a UUIDv7-based u128.
   */
  transferId?: string;
  /** TigerBeetle account ids as decimal strings (u128). */
  debitAccountId: string;
  creditAccountId: string;
  /** Integer kobo — never a float. */
  amountKobo: number;
  reference: string;
}

/** Posted balances of one backend account (consistency checker, WP-G13). */
export interface LedgerBackendAccountBalance {
  accountId: string;
  debitsPostedKobo: number;
  creditsPostedKobo: number;
}

export interface LedgerTransferResult {
  providerRef: string;
  status: 'posted' | 'failed';
  /** Honest provenance label. */
  source: string;
  detail?: string;
}

export interface LedgerBackendStatus extends DriverHealthFields {
  configured: boolean;
  healthy: boolean;
  detail: string;
}

export interface LedgerBackendDriver {
  readonly name: 'stub' | 'tigerbeetle';
  postTransfer(input: LedgerTransferInput): Promise<LedgerTransferResult>;
  status(): Promise<LedgerBackendStatus>;
  /**
   * Optional (WP-G13 pg↔TB consistency checker): posted debit/credit totals
   * per account id, aligned with the input order (undefined for accounts the
   * backend does not know). The stub moves no money and omits this; the
   * checker fails visible when the tigerbeetle driver is selected but cannot
   * answer balance lookups.
   */
  lookupAccountBalances?(
    accountIds: readonly string[]
  ): Promise<Array<LedgerBackendAccountBalance | undefined>>;
}

/* -------------------------------------------------------------------------
 * WP-G13 (Stage 27, ledger hardening): collision-resistant transfer ids.
 *
 * TigerBeetle deduplicates transfers by id — a reused id silently replays
 * the FIRST transfer, so a weak id source corrupts money movement without
 * an error. The pre-WP-G13 fallback derived the id from Date.now(), which
 * collides across concurrent callers on the same millisecond. The driver
 * now (a) generates a UUIDv7-based u128 when the caller supplies nothing
 * (millisecond-ordered AND randomised — collision-resistant), and (b)
 * hard-fails any supplied id that looks like a raw Date.now() epoch-millis
 * value. Math.random-derived decimal ids cannot be detected reliably and
 * are rejected only by policy: never derive ids from Math.random.
 * ---------------------------------------------------------------------- */

/**
 * Epoch-millis lookalike range: [2001-09-09, 2286-11-20). A 13-digit
 * decimal id in this range is overwhelmingly likely to be a raw
 * Date.now() value (caller-managed small ids are far below it,
 * UUID/ULID-derived u128s far above it).
 */
const EPOCH_MILLIS_LOOKALIKE_MIN = 1_000_000_000_000n;
const EPOCH_MILLIS_LOOKALIKE_MAX = 10_000_000_000_000n;

/**
 * Generates a collision-resistant transfer id as a decimal-string u128:
 * a UUIDv7 (48-bit epoch-millis prefix + version/variant + 74 random bits)
 * converted to a single 128-bit integer. Time-ordered like TigerBeetle's
 * own id() helper, without depending on the SDK at validation time.
 */
export function generateTransferId(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(nowMs) & 0xffffffffffffn; // 48-bit millisecond timestamp
  for (let shift = 40n, index = 0; index < 6; shift -= 8n, index += 1) {
    bytes[index] = Number((ms >> shift) & 0xffn);
  }
  bytes[6] = 0x70 | (bytes[6] & 0x0f); // version 7
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // RFC 4122 variant
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return BigInt(`0x${hex}`).toString(10);
}

/**
 * Hard-fails transfer ids that are not collision-resistant (WP-G13).
 * Validates the decimal-u128 shape, rejects TigerBeetle's null id (0), and
 * rejects values in the Date.now() epoch-millis lookalike range. Throws a
 * plain Error (caller bug — never trips the circuit breaker).
 */
export function assertCollisionResistantTransferId(transferId: string): void {
  if (!/^[0-9]+$/.test(transferId)) {
    throw new Error(
      `TigerBeetle transferId must be a decimal-string u128, got '${transferId.slice(0, 40)}'`
    );
  }
  const value = BigInt(transferId);
  if (value === 0n) {
    throw new Error("TigerBeetle transferId must be non-zero (0 is TigerBeetle's null id)");
  }
  if (value >= EPOCH_MILLIS_LOOKALIKE_MIN && value < EPOCH_MILLIS_LOOKALIKE_MAX) {
    throw new Error(
      `TigerBeetle transferId '${transferId}' looks like a raw Date.now() epoch-millis value — ` +
        'not collision-resistant across concurrent callers (a reused id silently replays the ' +
        "FIRST transfer). Supply a UUIDv7/ULID-derived id or the caller's idempotency key, " +
        'or omit transferId to have the driver generate one.'
    );
  }
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
      lastErrorClass: null,
      lastSuccessAt: null,
      detail:
        'Stub driver: deterministic simulated transfers; Postgres ledger is the system of record. ' +
        'TigerBeetle backend is legal-gated OFF unless LEDGER_DRIVER=tigerbeetle is set.'
    });
  }
}

/** Minimal client surface (tigerbeetle-node Client subset) for lazy import + fakes. */
export interface TigerBeetleClientLike {
  createTransfers(batch: Array<Record<string, unknown>>): Promise<Array<{ index: number; result: number | string }>>;
  /** WP-G13 consistency checker: posted account balances (sparse — unknown ids omitted). */
  lookupAccounts?(ids: bigint[]): Promise<Array<Record<string, unknown>>>;
  destroy(): void;
}

export type TigerBeetleClientFactory = () => Promise<TigerBeetleClientLike>;

/** Parses a decimal-string u128 field; throws a plain Error when invalid. */
function toU128(value: string, field: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
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
  private readonly tracker = new DriverHealthTracker();
  private readonly telemetry: TelemetryService;

  constructor(
    private readonly options: {
      clusterId: string;
      addresses: string[];
      clientFactory?: TigerBeetleClientFactory;
      ledger?: number;
      transferCode?: number;
      telemetry?: TelemetryService;
    }
  ) {
    // No-op-safe fallback: when the driver is built outside Nest DI (tests)
    // a plain TelemetryService still works — with the SDK disabled every
    // helper costs ~nothing and never throws into the transfer path.
    this.telemetry = options.telemetry ?? new TelemetryService();
  }

  async postTransfer(input: LedgerTransferInput): Promise<LedgerTransferResult> {
    // Validation happens before the circuit: malformed ids are caller
    // errors (plain Error), not broker failures, so they never trip the
    // breaker. Validation also stays OUTSIDE the telemetry span — the
    // duration histogram measures TigerBeetle operations, not caller bugs.
    // WP-G13: the id is NEVER derived from Date.now() — an omitted id gets
    // a collision-resistant UUIDv7-based u128, and a supplied id that looks
    // like epoch millis hard-fails (a reused id silently replays the first
    // transfer, so weak id generation corrupts money movement silently).
    const transferId = input.transferId ?? generateTransferId();
    assertCollisionResistantTransferId(transferId);
    const transfer = {
      id: toU128(transferId, 'transferId'),
      debit_account_id: toU128(input.debitAccountId, 'debitAccountId'),
      credit_account_id: toU128(input.creditAccountId, 'creditAccountId'),
      amount: toU128(String(input.amountKobo), 'amountKobo'),
      ledger: this.options.ledger ?? TIGERBEETLE_DEFAULT_LEDGER,
      code: this.options.transferCode ?? TIGERBEETLE_DEFAULT_TRANSFER_CODE,
      user_data_64: input.reference
    };
    // Stage 25.2: one span per TigerBeetle operation. Attributes carry the
    // ledger id and transfer count only — never account ids or references
    // (financial PII). Duration histogram + error counter are recorded
    // around the span so failures are still measured.
    const spanAttributes = {
      'tb.operation': 'create_transfers',
      'tb.ledger': transfer.ledger,
      'tb.transfer_count': 1
    };
    const started = performance.now();
    try {
      return await this.telemetry.withSpan(
        'tigerbeetle.create_transfers',
        spanAttributes,
        async () => {
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
            this.telemetry.increment('tigerbeetle.transfer.rejected', 1, spanAttributes);
            return {
              providerRef: transferId,
              status: 'failed',
              source: 'tigerbeetle cluster (proof-of-port — not the system of record)',
              detail: `TigerBeetle rejected the transfer: ${JSON.stringify(errors[0])}`
            };
          } catch (error) {
            this.recordFailure(error);
            if (error instanceof ProviderRequestError) {
              throw error;
            }
            throw new ProviderRequestError('tigerbeetle', 'network', error);
          }
        }
      );
    } catch (error) {
      this.telemetry.increment('tigerbeetle.operation.errors', 1, spanAttributes);
      throw error;
    } finally {
      this.telemetry.record(
        'tigerbeetle.operation.duration',
        performance.now() - started,
        spanAttributes
      );
    }
  }

  /**
   * Posted account balances for the pg↔TB consistency checker (WP-G13).
   * Same circuit-breaker doctrine as postTransfer; result rows are aligned
   * with the requested ids (undefined where the cluster has no account).
   */
  async lookupAccountBalances(
    accountIds: readonly string[]
  ): Promise<Array<LedgerBackendAccountBalance | undefined>> {
    const ids = accountIds.map((accountId) => toU128(accountId, 'accountId'));
    this.assertCircuitClosed();
    try {
      const client = await this.ensureClient();
      if (typeof client.lookupAccounts !== 'function') {
        throw new ProviderRequestError(
          'tigerbeetle',
          'network',
          new Error('the configured TigerBeetle client does not support lookupAccounts')
        );
      }
      const found = await client.lookupAccounts(ids);
      this.recordSuccess();
      const byId = new Map<string, Record<string, unknown>>();
      for (const account of found) {
        const id = account.id;
        byId.set(typeof id === 'bigint' ? id.toString(10) : String(id), account);
      }
      return accountIds.map((accountId) => {
        const account = byId.get(accountId);
        if (!account) {
          return undefined;
        }
        return {
          accountId,
          debitsPostedKobo: Number(account.debits_posted ?? 0),
          creditsPostedKobo: Number(account.credits_posted ?? 0)
        };
      });
    } catch (error) {
      this.recordFailure(error);
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
      circuitBreaker: circuitBreakerState(
        this.consecutiveFailures,
        LEDGER_CIRCUIT_THRESHOLD,
        this.circuitOpenUntil
      ),
      lastErrorClass: this.tracker.lastErrorClass,
      lastSuccessAt: this.tracker.lastSuccessAt,
      detail:
        `TigerBeetle driver selected (cluster ${this.options.clusterId}, replicas ${this.options.addresses.join(', ')}). ` +
        'PROOF-OF-PORT: not wired into LedgerService money movement (legal gate); connects on first transfer.'
    });
  }

  /** Visible for tests: whether the circuit breaker is currently open. */
  get circuitOpen(): boolean {    return (
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
    this.tracker.recordSuccess();
  }

  private recordFailure(error: unknown): void {
    this.consecutiveFailures += 1;
    this.tracker.recordError(error);
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
  env: NodeJS.ProcessEnv = process.env,
  telemetry?: TelemetryService
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
      addresses,
      telemetry
    });
  }
  return new StubLedgerBackendDriver();
}
