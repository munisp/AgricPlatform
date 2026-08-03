/**
 * Mojaloop payment-interop adapter (wave FABRIC): quote + transfer
 * interop behind one MojaloopAdapter port, following the payments driver
 * pattern (payments.drivers.ts). The stub driver is the DEFAULT —
 * deterministic, clearly labelled simulated fixtures. MOJALOOP_DRIVER=
 * simulator selects the live driver, which targets a Mojaloop SIMULATOR
 * endpoint (mojaloop-simulator / ml-testing-toolkit — see
 * docs/integration-fabric.md): it REQUIRES MOJALOOP_SIM_URL and fails
 * closed with ProviderConfigError at boot when the URL is absent, and
 * with ProviderHttpError/ProviderRequestError (plus circuit breaker) on
 * call failure — never a silent fallback to simulated quotes.
 *
 * Scope honesty: there is NO full Mojaloop deployment here (a real switch
 * is helm-chart scale, out of compose scope). The simulator path proves
 * the adapter contract only; no live Mojaloop flow has been executed.
 */
import {
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  httpJson,
  requireEnv
} from './http.js';

/** DI token for the selected Mojaloop adapter. */
export const MOJALOOP_ADAPTER = Symbol('MOJALOOP_ADAPTER');

/** Number of consecutive failures before the circuit opens. */
export const MOJALOOP_CIRCUIT_THRESHOLD = 3;
/** How long the circuit stays open before the next call is allowed through. */
export const MOJALOOP_CIRCUIT_COOLDOWN_MS = 30_000;

export interface MojaloopQuoteInput {
  /** Whole naira at the port boundary (same convention as PaymentDriver). */
  amountNaira: number;
  payerMsisdn: string;
  payeeMsisdn: string;
  reference: string;
}

export interface MojaloopQuote {
  quoteId: string;
  reference: string;
  amountNaira: number;
  feeNaira: number;
  status: 'received' | 'simulated';
  /** Honest provenance label. */
  source: string;
}

export interface MojaloopTransferInput extends MojaloopQuoteInput {
  quoteId: string;
}

export interface MojaloopTransfer {
  transferId: string;
  reference: string;
  status: 'committed' | 'pending' | 'failed' | 'simulated';
  /** Honest provenance label. */
  source: string;
}

export interface MojaloopAdapterStatus {
  configured: boolean;
  healthy: boolean;
  detail: string;
}

export interface MojaloopAdapter {
  readonly name: 'stub' | 'simulator';
  requestQuote(input: MojaloopQuoteInput): Promise<MojaloopQuote>;
  executeTransfer(input: MojaloopTransferInput): Promise<MojaloopTransfer>;
  status(): Promise<MojaloopAdapterStatus>;
}

/** Deterministic 32-bit FNV-1a hash so stub output is stable per input. */
function mojaloopHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Default driver: deterministic, clearly labelled simulated quotes and
 * transfers. No network I/O; nothing here is a real Mojaloop flow.
 */
export class StubMojaloopAdapter implements MojaloopAdapter {
  readonly name = 'stub' as const;

  requestQuote(input: MojaloopQuoteInput): Promise<MojaloopQuote> {
    const hash = mojaloopHash(
      `quote:${input.payerMsisdn}:${input.payeeMsisdn}:${input.amountNaira}:${input.reference}`
    );
    return Promise.resolve({
      quoteId: `stub-quote-${hash.toString(16).padStart(8, '0')}`,
      reference: input.reference,
      amountNaira: input.amountNaira,
      feeNaira: 0,
      status: 'simulated',
      source: 'stub-fixture (simulated — not a Mojaloop switch quote)'
    });
  }

  executeTransfer(input: MojaloopTransferInput): Promise<MojaloopTransfer> {
    const hash = mojaloopHash(`transfer:${input.quoteId}:${input.reference}`);
    return Promise.resolve({
      transferId: `stub-transfer-${hash.toString(16).padStart(8, '0')}`,
      reference: input.reference,
      status: 'simulated',
      source: 'stub-fixture (simulated — no funds moved through any Mojaloop switch)'
    });
  }

  status(): Promise<MojaloopAdapterStatus> {
    return Promise.resolve({
      configured: true,
      healthy: true,
      detail:
        'Stub driver: deterministic simulated quotes/transfers. Set MOJALOOP_DRIVER=simulator ' +
        'and MOJALOOP_SIM_URL to target a Mojaloop simulator (proves the adapter contract only).'
    });
  }
}

interface SimulatorQuoteResponse {
  quoteId?: string;
  transferAmount?: { amount?: string };
  payeeFspFee?: { amount?: string };
}

interface SimulatorTransferResponse {
  transferId?: string;
  fulfilment?: string;
  completedTimestamp?: string;
  transferState?: string;
}

/**
 * Live driver against a Mojaloop simulator (FSPIOP-shaped /quotes and
 * /transfers, as exposed by mojaloop-simulator and the Mojaloop Testing
 * Toolkit). Transport and HTTP failures trip a call-time circuit breaker
 * and surface as ProviderRequestError/ProviderHttpError — fail closed.
 */
export class MojaloopSimulatorAdapter implements MojaloopAdapter {
  readonly name = 'simulator' as const;

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(private readonly baseUrl: string) {}

  async requestQuote(input: MojaloopQuoteInput): Promise<MojaloopQuote> {
    const response = await this.call(() =>
      httpJson<SimulatorQuoteResponse>('mojaloop', `${this.baseUrl}/quotes`, {
        headers: this.fspiopHeaders('quotes'),
        body: {
          quoteId: input.reference,
          transactionId: input.reference,
          payer: { partyIdInfo: { partyIdType: 'MSISDN', partyIdentifier: input.payerMsisdn } },
          payee: { partyIdInfo: { partyIdType: 'MSISDN', partyIdentifier: input.payeeMsisdn } },
          amountType: 'SEND',
          amount: { currency: 'NGN', amount: String(input.amountNaira) }
        }
      })
    );
    return {
      quoteId: response.quoteId ?? input.reference,
      reference: input.reference,
      amountNaira: Number(response.transferAmount?.amount ?? input.amountNaira),
      feeNaira: Number(response.payeeFspFee?.amount ?? 0),
      status: 'received',
      source: 'mojaloop simulator (adapter-contract proof — not a live switch)'
    };
  }

  async executeTransfer(input: MojaloopTransferInput): Promise<MojaloopTransfer> {
    const response = await this.call(() =>
      httpJson<SimulatorTransferResponse>('mojaloop', `${this.baseUrl}/transfers`, {
        headers: this.fspiopHeaders('transfers'),
        body: {
          transferId: input.quoteId,
          payerFsp: 'agric-platform',
          payeeFsp: 'simulator',
          amount: { currency: 'NGN', amount: String(input.amountNaira) },
          ilpPacket: 'SIMULATED-ILP-PACKET',
          condition: 'SIMULATED-CONDITION',
          expiration: new Date(Date.now() + 60_000).toISOString()
        }
      })
    );
    const state = response.transferState ?? (response.fulfilment ? 'COMMITTED' : 'RECEIVED');
    return {
      transferId: response.transferId ?? input.quoteId,
      reference: input.reference,
      status: state === 'COMMITTED' ? 'committed' : state === 'ABORTED' ? 'failed' : 'pending',
      source: 'mojaloop simulator (adapter-contract proof — not a live switch)'
    };
  }

  status(): Promise<MojaloopAdapterStatus> {
    return Promise.resolve({
      configured: true,
      healthy: !this.circuitOpen,
      detail: this.circuitOpen
        ? `Mojaloop simulator circuit open after ${this.consecutiveFailures} consecutive failures.`
        : `Mojaloop simulator adapter configured at ${this.baseUrl} (adapter-contract proof only — reachability verified at call time, fail closed).`
    });
  }

  /** Visible for tests: whether the circuit breaker is currently open. */
  get circuitOpen(): boolean {
    return (
      this.consecutiveFailures >= MOJALOOP_CIRCUIT_THRESHOLD &&
      Date.now() < this.circuitOpenUntil
    );
  }

  private fspiopHeaders(resource: 'quotes' | 'transfers'): Record<string, string> {
    return {
      'content-type': `application/vnd.interoperability.${resource}+json;version=1.0`,
      accept: `application/vnd.interoperability.${resource}+json;version=1.0`,
      'fspiop-source': 'agric-platform',
      'fspiop-destination': 'simulator'
    };
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    this.assertCircuitClosed();
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private assertCircuitClosed(): void {
    if (this.circuitOpen) {
      throw new ProviderRequestError(
        'mojaloop',
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
    if (this.consecutiveFailures >= MOJALOOP_CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + MOJALOOP_CIRCUIT_COOLDOWN_MS;
    }
  }
}

export { ProviderConfigError, ProviderHttpError, ProviderRequestError };

/**
 * Builds the configured adapter. Default is the stub (deterministic
 * simulated fixtures); MOJALOOP_DRIVER=simulator requires MOJALOOP_SIM_URL
 * and fails closed with ProviderConfigError otherwise.
 */
export function createMojaloopAdapter(env: NodeJS.ProcessEnv = process.env): MojaloopAdapter {
  const flag = (env.MOJALOOP_DRIVER ?? 'stub').toLowerCase();
  if (flag === 'simulator') {
    const baseUrl = requireEnv('mojaloop', env, ['MOJALOOP_SIM_URL']).replace(/\/+$/, '');
    return new MojaloopSimulatorAdapter(baseUrl);
  }
  return new StubMojaloopAdapter();
}
