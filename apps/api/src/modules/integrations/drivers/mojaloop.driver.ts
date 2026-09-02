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
 *
 * Stage 25 / wave W2 adds the LIVE driver (MOJALOOP_DRIVER=live): a real
 * FSPIOP/ISO20022 client against a Mojaloop integration environment's
 * account-lookup service (ALS), quoting service and transfer (ml-api /
 * scheme-adapter) endpoints. It requires MOJALOOP_ALS_ENDPOINT,
 * MOJALOOP_QUOTING_ENDPOINT and MOJALOOP_TRANSFERS_ENDPOINT and fails
 * closed with ProviderConfigError at boot when any is missing — and in
 * production additionally refuses placeholder endpoints. Optional
 * MOJALOOP_JWS_SIGNING_KEY_PATH enables FSPIOP JWS request signing (the
 * header is only ever attached when a real key is configured — signatures
 * are never fabricated); optional MOJALOOP_TLS_* paths enable mutual TLS
 * via an undici dispatcher. Every outbound call is wrapped in an OTel
 * span with dfsp/operation/status attributes (never account PII) plus
 * latency histogram and error counter metrics.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isProduction } from '../../../common/auth/auth.config.js';
import { TelemetryService } from '../../../common/telemetry/telemetry.service.js';
import {
  PROVIDER_TIMEOUT_MS,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  httpJson,
  missingEnv,
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
  /**
   * ILP condition from the quote (payee DFSP supplies it in the FSPIOP
   * quote response). When absent the live driver derives one from a
   * locally generated fulfilment preimage (see LiveMojaloopDriver).
   */
  condition?: string;
  /** ILP packet from the quote response, when the switch supplied one. */
  ilpPacket?: string;
  /** Payee DFSP id; defaults to the configured counterparty. */
  payeeFsp?: string;
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
  readonly name: 'stub' | 'simulator' | 'live';
  requestQuote(input: MojaloopQuoteInput): Promise<MojaloopQuote>;
  executeTransfer(input: MojaloopTransferInput): Promise<MojaloopTransfer>;
  status(): Promise<MojaloopAdapterStatus>;
}

/** Result of an ALS party lookup (GET /parties/{idType}/{idValue}). */
export interface MojaloopPartyLookup {
  idType: string;
  idValue: string;
  /** DFSP id that hosts the party, when the ALS resolved it. */
  fspId?: string;
  /** Display name from the payee DFSP callback, when present. */
  displayName?: string;
  source: string;
}

/** Inbound PUT /transfers/{id} callback body (FSPIOP fulfil/abort). */
export interface MojaloopTransferCallback {
  transferState?: string;
  fulfilment?: string;
  completedTimestamp?: string;
}

/**
 * Extended surface of the live driver: the MojaloopAdapter port covers the
 * quote/transfer/status flow; the live driver additionally exposes the ALS
 * party lookup, the transfer status query and the inbound-callback handler
 * that completes the transfer state machine. The integrations module
 * exposes no Mojaloop-specific HTTP endpoints today (only the generic
 * HMAC-signed webhooks/:provider route), so handleTransferCallback is the
 * seam a future FSPIOP callback controller must call — nothing here
 * pretends a callback route exists.
 */
export interface LiveMojaloopAdapter extends MojaloopAdapter {
  readonly name: 'live';
  lookupParty(idType: string, idValue: string): Promise<MojaloopPartyLookup>;
  transferStatus(transferId: string): Promise<MojaloopTransfer>;
  handleTransferCallback(transferId: string, body: MojaloopTransferCallback): MojaloopTransfer;
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

/** Configuration for the live FSPIOP driver. */
export interface LiveMojaloopConfig {
  /** Account-lookup service base URL (GET {als}/parties/{idType}/{idValue}). */
  alsEndpoint: string;
  /** Quoting service base URL (POST {quoting}/quotes). */
  quotingEndpoint: string;
  /** Transfer service base URL (POST/GET {transfers}/transfers[/{id}]). */
  transfersEndpoint: string;
  /** Our DFSP id (fspiop-source header). Defaults to 'agric-platform'. */
  dfspId: string;
  /** PEM private key for FSPIOP JWS signing; unsigned when unset. */
  jwsSigningKeyPath?: string;
  /** mTLS client certificate/key/CA PEM paths (all-or-none cert+key). */
  tlsCertPath?: string;
  tlsKeyPath?: string;
  tlsCaPath?: string;
}

interface FspiopQuoteResponse {
  quoteId?: string;
  transferAmount?: { amount?: string };
  payeeFspFee?: { amount?: string };
  ilpPacket?: string;
  condition?: string;
}

interface FspiopTransferResponse {
  transferId?: string;
  fulfilment?: string;
  completedTimestamp?: string;
  transferState?: string;
}

/** True for endpoints that are never legitimate in a production deployment. */
function isPlaceholderEndpoint(url: string): boolean {
  return (
    !/^https?:\/\//i.test(url) ||
    /localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(com|org)|changeme|placeholder/i.test(url)
  );
}

/** Deterministic UUID-shaped id (SHA-256 of the namespaced key, v4 layout). */
function deterministicUuid(namespace: string, key: string): string {
  const hex = createHash('sha256').update(`${namespace}:${key}`).digest('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}` +
    `-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

/** Base64url encoding (ILP condition/fulfilment wire format). */
function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/**
 * Live FSPIOP/ISO20022 driver against a Mojaloop integration environment:
 * party lookup via the account-lookup service, quote requests via the
 * quoting service, and the transfer prepare/fulfil flow via the transfer
 * (ml-api-adapter / scheme-adapter) endpoints. All failures fail closed:
 * HTTP errors raise ProviderHttpError, transport failures
 * ProviderRequestError, and MOJALOOP_CIRCUIT_THRESHOLD consecutive failures
 * open a call-time circuit breaker.
 *
 * Idempotency doctrine (mirrors the platform outbox/dedup doctrine): the
 * transferId is a deterministic UUID derived from the caller's business
 * reference, so a retried prepare re-uses the same switch-level id (the
 * switch deduplicates on transferId) and an in-process cache replays the
 * recorded outcome instead of re-posting.
 *
 * Security honesty:
 * - FSPIOP JWS signatures (fspiop-signature header, PS256 detached payload
 *   per the Mojaloop API definition) are attached ONLY when
 *   MOJALOOP_JWS_SIGNING_KEY_PATH is configured. When unset, requests go
 *   unsigned — signatures are never fabricated. In most integration
 *   environments JWS/mTLS are terminated by the scheme adapter sidecar;
 *   configure the key path only when this process talks to the switch
 *   directly.
 * - mTLS requires both MOJALOOP_TLS_CERT_PATH and MOJALOOP_TLS_KEY_PATH
 *   (optional MOJALOOP_TLS_CA_PATH) and is applied via an undici Agent
 *   dispatcher on the global fetch transport.
 */
export class LiveMojaloopDriver implements LiveMojaloopAdapter {
  readonly name = 'live' as const;

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  /** transferId → recorded outcome; retries replay instead of re-posting. */
  private readonly transferCache = new Map<string, MojaloopTransfer>();
  /** transferId → locally generated fulfilment preimage (see executeTransfer). */
  private readonly fulfilments = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<MojaloopTransfer>>();
  private dispatcher?: unknown;
  private dispatcherInitialised = false;
  private jwsKey?: CryptoKey;
  private jwsKeyInitialised = false;

  constructor(
    private readonly config: LiveMojaloopConfig,
    private readonly telemetry: TelemetryService = new TelemetryService()
  ) {}

  /** Deterministic, switch-deduplicable transfer id for a business reference. */
  static transferIdFor(reference: string): string {
    return deterministicUuid('agric:mojaloop:transfer', reference);
  }

  /** Deterministic transaction id so quote retries reuse one switch transaction. */
  static transactionIdFor(reference: string): string {
    return deterministicUuid('agric:mojaloop:transaction', reference);
  }

  async lookupParty(idType: string, idValue: string): Promise<MojaloopPartyLookup> {
    const response = await this.call<{ party?: { partyIdInfo?: { fspId?: string }; personalInfo?: { complexName?: { firstName?: string; lastName?: string } } } }>(
      'party-lookup',
      `${this.config.alsEndpoint}/parties/${encodeURIComponent(idType)}/${encodeURIComponent(idValue)}`,
      'parties',
      'GET'
    );
    const party = response?.party;
    const complexName = party?.personalInfo?.complexName;
    return {
      idType,
      idValue,
      fspId: party?.partyIdInfo?.fspId,
      displayName: complexName
        ? [complexName.firstName, complexName.lastName].filter(Boolean).join(' ')
        : undefined,
      source: `mojaloop ALS (${this.config.alsEndpoint})`
    };
  }

  async requestQuote(input: MojaloopQuoteInput): Promise<MojaloopQuote> {
    const quoteId = randomUUID();
    const response = await this.call<FspiopQuoteResponse>(
      'quote',
      `${this.config.quotingEndpoint}/quotes`,
      'quotes',
      'POST',
      {
        quoteId,
        transactionId: LiveMojaloopDriver.transactionIdFor(input.reference),
        payee: { partyIdInfo: { partyIdType: 'MSISDN', partyIdentifier: input.payeeMsisdn } },
        payer: { partyIdInfo: { partyIdType: 'MSISDN', partyIdentifier: input.payerMsisdn } },
        amountType: 'SEND',
        amount: { currency: 'NGN', amount: String(input.amountNaira) },
        transactionType: { scenario: 'TRANSFER', initiator: 'PAYER', initiatorType: 'CONSUMER' }
      }
    );
    return {
      quoteId: response?.quoteId ?? quoteId,
      reference: input.reference,
      amountNaira: Number(response?.transferAmount?.amount ?? input.amountNaira),
      feeNaira: Number(response?.payeeFspFee?.amount ?? 0),
      status: 'received',
      source: `mojaloop quoting service (${this.config.quotingEndpoint})`
    };
  }

  async executeTransfer(input: MojaloopTransferInput): Promise<MojaloopTransfer> {
    const transferId = LiveMojaloopDriver.transferIdFor(input.reference);
    const cached = this.transferCache.get(transferId);
    if (cached && cached.status !== 'failed') {
      return cached; // idempotent replay: never double-post a settled transfer
    }
    const pending = this.inFlight.get(transferId);
    if (pending) {
      return pending; // concurrent retry joins the same in-flight prepare
    }
    const attempt = this.prepareTransfer(transferId, input)
      .then((transfer) => {
        this.transferCache.set(transferId, transfer);
        return transfer;
      })
      .finally(() => this.inFlight.delete(transferId));
    this.inFlight.set(transferId, attempt);
    return attempt;
  }

  async transferStatus(transferId: string): Promise<MojaloopTransfer> {
    const response = await this.call<FspiopTransferResponse>(
      'transfer-status',
      `${this.config.transfersEndpoint}/transfers/${encodeURIComponent(transferId)}`,
      'transfers',
      'GET'
    );
    const transfer = this.mapTransfer(transferId, transferId, response);
    this.transferCache.set(transferId, transfer);
    return transfer;
  }

  /**
   * Completes the transfer state machine from an inbound PUT /transfers/{id}
   * fulfil/abort callback. When this driver generated the ILP condition
   * itself, the fulfilment preimage is verified before COMMITTED is
   * accepted — an unverifiable fulfilment fails closed.
   */
  handleTransferCallback(transferId: string, body: MojaloopTransferCallback): MojaloopTransfer {
    const state = body.transferState ?? (body.fulfilment ? 'COMMITTED' : undefined);
    if (state === 'COMMITTED') {
      const expected = this.fulfilments.get(transferId);
      if (expected && body.fulfilment) {
        const derived = base64url(
          createHash('sha256').update(Buffer.from(body.fulfilment, 'base64url')).digest()
        );
        if (derived !== expected) {
          throw new ProviderRequestError(
            'mojaloop',
            'network',
            new Error(`fulfilment for transfer ${transferId} does not match the ILP condition`)
          );
        }
      }
    }
    const transfer: MojaloopTransfer = {
      transferId,
      reference: transferId,
      status: state === 'COMMITTED' ? 'committed' : state === 'ABORTED' ? 'failed' : 'pending',
      source: `mojaloop transfer callback (PUT /transfers/${transferId})`
    };
    this.transferCache.set(transferId, transfer);
    return transfer;
  }

  status(): Promise<MojaloopAdapterStatus> {
    const security = [
      this.config.jwsSigningKeyPath ? 'jws:configured' : 'jws:unsigned (no key configured)',
      this.config.tlsCertPath ? 'mtls:configured' : 'mtls:off'
    ].join(', ');
    return Promise.resolve({
      configured: true,
      healthy: !this.circuitOpen,
      detail: this.circuitOpen
        ? `Mojaloop live circuit open after ${this.consecutiveFailures} consecutive failures.`
        : `Live Mojaloop FSPIOP driver (dfsp ${this.config.dfspId}; ALS ${this.config.alsEndpoint}, ` +
          `quoting ${this.config.quotingEndpoint}, transfers ${this.config.transfersEndpoint}; ${security}). ` +
          'Reachability verified at call time, fail closed.'
    });
  }

  /** Visible for tests: whether the circuit breaker is currently open. */
  get circuitOpen(): boolean {
    return (
      this.consecutiveFailures >= MOJALOOP_CIRCUIT_THRESHOLD &&
      Date.now() < this.circuitOpenUntil
    );
  }

  private async prepareTransfer(
    transferId: string,
    input: MojaloopTransferInput
  ): Promise<MojaloopTransfer> {
    // ILP condition: prefer the payee-supplied condition from the quote.
    // Only when the quote carried none do we generate a fulfilment
    // preimage locally and derive condition = SHA-256(fulfilment); the
    // preimage is retained so the PUT callback fulfilment can be verified.
    let condition = input.condition;
    if (!condition) {
      const fulfilment = base64url(Buffer.from(randomUUID().replace(/-/g, ''), 'hex'));
      condition = base64url(createHash('sha256').update(Buffer.from(fulfilment, 'base64url')).digest());
      this.fulfilments.set(transferId, condition);
    }
    const response = await this.call<FspiopTransferResponse>(
      'transfer-prepare',
      `${this.config.transfersEndpoint}/transfers`,
      'transfers',
      'POST',
      {
        transferId,
        payerFsp: this.config.dfspId,
        payeeFsp: input.payeeFsp ?? 'mojaloop-switch',
        amount: { currency: 'NGN', amount: String(input.amountNaira) },
        ilpPacket: input.ilpPacket ?? '',
        condition,
        expiration: new Date(Date.now() + 60_000).toISOString()
      }
    );
    return this.mapTransfer(transferId, input.reference, response);
  }

  private mapTransfer(
    transferId: string,
    reference: string,
    response: FspiopTransferResponse | undefined
  ): MojaloopTransfer {
    const state = response?.transferState ?? (response?.fulfilment ? 'COMMITTED' : 'RECEIVED');
    return {
      transferId: response?.transferId ?? transferId,
      reference,
      status: state === 'COMMITTED' ? 'committed' : state === 'ABORTED' ? 'failed' : 'pending',
      source: `mojaloop transfer service (${this.config.transfersEndpoint})`
    };
  }

  private async call<T>(
    operation: string,
    url: string,
    resource: 'parties' | 'quotes' | 'transfers',
    method: 'GET' | 'POST',
    body?: unknown
  ): Promise<T | undefined> {
    this.assertCircuitClosed();
    const startedAt = Date.now();
    const metricAttrs = { dfsp: this.config.dfspId, operation };
    try {
      const result = await this.telemetry.withSpan(
        `mojaloop.${operation}`,
        { dfsp: this.config.dfspId, operation, status: 'started' },
        () => this.request<T>(operation, url, resource, method, body)
      );
      this.recordSuccess();
      this.telemetry.record('mojaloop.request.duration_ms', Date.now() - startedAt, {
        ...metricAttrs,
        status: 'ok'
      });
      return result;
    } catch (error) {
      this.recordFailure();
      this.telemetry.increment('mojaloop.errors.total', 1, { ...metricAttrs, status: 'error' });
      this.telemetry.record('mojaloop.request.duration_ms', Date.now() - startedAt, {
        ...metricAttrs,
        status: 'error'
      });
      throw error;
    }
  }

  /**
   * Single outbound HTTP seam for the live driver: same timeout and error
   * mapping as the shared http.ts wrapper, plus the mTLS dispatcher (which
   * the shared wrapper cannot express). No account PII is attached to
   * spans/metrics; URLs only ever carry party ids for the ALS lookup.
   */
  private async request<T>(
    operation: string,
    url: string,
    resource: 'parties' | 'quotes' | 'transfers',
    method: 'GET' | 'POST',
    body?: unknown
  ): Promise<T | undefined> {
    const bodyText = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = await this.fspiopHeaders(resource, method, bodyText, url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    let response: Response;
    try {
      const init: RequestInit & { dispatcher?: unknown } = {
        method,
        headers,
        body: bodyText,
        signal: controller.signal
      };
      const dispatcher = await this.ensureDispatcher();
      if (dispatcher) {
        init.dispatcher = dispatcher;
      }
      response = await fetch(url, init);
    } catch (error) {
      const reason = controller.signal.aborted ? 'timeout' : 'network';
      throw new ProviderRequestError('mojaloop', reason, error);
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new ProviderHttpError('mojaloop', response.status, text);
    }
    try {
      return (text.length > 0 ? JSON.parse(text) : undefined) as T | undefined;
    } catch {
      return undefined;
    }
  }

  private async fspiopHeaders(
    resource: 'parties' | 'quotes' | 'transfers',
    method: 'GET' | 'POST',
    bodyText: string | undefined,
    url: string
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      accept: `application/vnd.interoperability.${resource}+json;version=1.0`,
      date: new Date().toUTCString(),
      'fspiop-source': this.config.dfspId
    };
    if (bodyText !== undefined) {
      headers['content-type'] = `application/vnd.interoperability.${resource}+json;version=1.0`;
    }
    const signature = await this.signJws(method, url, bodyText ?? '');
    if (signature) {
      headers['fspiop-signature'] = signature;
    }
    return headers;
  }

  /**
   * FSPIOP JWS profile (Mojaloop API Definition v1.1): compact JWS, PS256,
   * detached payload. Signed ONLY when a real key is configured; otherwise
   * undefined and the request goes unsigned (scheme-adapter deployments
   * terminate JWS at the sidecar). Never fabricates a signature.
   */
  private async signJws(
    method: string,
    url: string,
    bodyText: string
  ): Promise<string | undefined> {
    const key = await this.ensureJwsKey();
    if (!key) {
      return undefined;
    }
    const { CompactSign } = await import('jose');
    const protectedHeader = {
      alg: 'PS256',
      'FSPIOP-URI': new URL(url).pathname,
      'FSPIOP-HTTP-Method': method,
      Date: new Date().toUTCString()
    };
    const jws = await new CompactSign(new TextEncoder().encode(bodyText))
      .setProtectedHeader(protectedHeader)
      .sign(key);
    const [header, , signature] = jws.split('.');
    return `${header}..${signature}`; // detached payload form
  }

  private async ensureJwsKey(): Promise<CryptoKey | undefined> {
    if (this.jwsKeyInitialised) {
      return this.jwsKey;
    }
    this.jwsKeyInitialised = true;
    if (!this.config.jwsSigningKeyPath) {
      return undefined;
    }
    const { importPKCS8 } = await import('jose');
    const pem = await readFile(this.config.jwsSigningKeyPath, 'utf8');
    this.jwsKey = (await importPKCS8(pem, 'PS256')) as CryptoKey;
    return this.jwsKey;
  }

  private async ensureDispatcher(): Promise<unknown> {
    if (this.dispatcherInitialised) {
      return this.dispatcher;
    }
    this.dispatcherInitialised = true;
    const { tlsCertPath, tlsKeyPath, tlsCaPath } = this.config;
    if (!tlsCertPath && !tlsKeyPath && !tlsCaPath) {
      return undefined;
    }
    if (!tlsCertPath || !tlsKeyPath) {
      // Half-configured mTLS is a configuration error — fail closed.
      throw new ProviderConfigError('mojaloop', [
        ...(tlsCertPath ? [] : ['MOJALOOP_TLS_CERT_PATH']),
        ...(tlsKeyPath ? [] : ['MOJALOOP_TLS_KEY_PATH'])
      ]);
    }
    const { Agent } = await import('undici');
    this.dispatcher = new Agent({
      connect: {
        cert: await readFile(tlsCertPath, 'utf8'),
        key: await readFile(tlsKeyPath, 'utf8'),
        ...(tlsCaPath ? { ca: await readFile(tlsCaPath, 'utf8') } : {})
      }
    });
    return this.dispatcher;
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

/**
 * Builds the configured adapter. Default is the stub (deterministic
 * simulated fixtures); MOJALOOP_DRIVER=simulator requires MOJALOOP_SIM_URL
 * and fails closed with ProviderConfigError otherwise. MOJALOOP_DRIVER=live
 * requires all three FSPIOP endpoints (ALS/quoting/transfers), fails closed
 * with ProviderConfigError when any is missing, and in production
 * additionally refuses placeholder endpoints (localhost/example/changeme)
 * so a misconfigured pod never boots pretending to reach a real switch.
 */
export function createMojaloopAdapter(
  env: NodeJS.ProcessEnv = process.env,
  telemetry?: TelemetryService
): MojaloopAdapter {
  const flag = (env.MOJALOOP_DRIVER ?? 'stub').toLowerCase();
  if (flag === 'simulator') {
    const baseUrl = requireEnv('mojaloop', env, ['MOJALOOP_SIM_URL']).replace(/\/+$/, '');
    return new MojaloopSimulatorAdapter(baseUrl);
  }
  if (flag === 'live') {
    const endpointEnvs = [
      'MOJALOOP_ALS_ENDPOINT',
      'MOJALOOP_QUOTING_ENDPOINT',
      'MOJALOOP_TRANSFERS_ENDPOINT'
    ] as const;
    const missing = missingEnv(env, endpointEnvs);
    if (missing.length > 0) {
      throw new ProviderConfigError('mojaloop', missing);
    }
    if (isProduction(env)) {
      const placeholders = endpointEnvs.filter((name) =>
        isPlaceholderEndpoint(env[name] as string)
      );
      if (placeholders.length > 0) {
        // Production doctrine: refuse boot rather than let a pod believe it
        // talks to a real switch through a placeholder/loopback endpoint.
        throw new ProviderConfigError('mojaloop', placeholders);
      }
    }
    const config: LiveMojaloopConfig = {
      alsEndpoint: (env.MOJALOOP_ALS_ENDPOINT as string).replace(/\/+$/, ''),
      quotingEndpoint: (env.MOJALOOP_QUOTING_ENDPOINT as string).replace(/\/+$/, ''),
      transfersEndpoint: (env.MOJALOOP_TRANSFERS_ENDPOINT as string).replace(/\/+$/, ''),
      dfspId: env.MOJALOOP_DFSP_ID?.trim() || 'agric-platform',
      jwsSigningKeyPath: env.MOJALOOP_JWS_SIGNING_KEY_PATH || undefined,
      tlsCertPath: env.MOJALOOP_TLS_CERT_PATH || undefined,
      tlsKeyPath: env.MOJALOOP_TLS_KEY_PATH || undefined,
      tlsCaPath: env.MOJALOOP_TLS_CA_PATH || undefined
    };
    return new LiveMojaloopDriver(config, telemetry);
  }
  return new StubMojaloopAdapter();
}
