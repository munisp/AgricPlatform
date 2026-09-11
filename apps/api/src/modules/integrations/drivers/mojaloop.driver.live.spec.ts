import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryService } from '../../../common/telemetry/telemetry.service.js';
import { ProviderConfigError, ProviderHttpError, ProviderRequestError } from './http.js';
import {
  createMojaloopAdapter,
  LiveMojaloopDriver,
  MOJALOOP_CIRCUIT_THRESHOLD,
  type LiveMojaloopConfig,
  type MojaloopQuoteInput
} from './mojaloop.driver.js';

const CONFIG: LiveMojaloopConfig = {
  alsEndpoint: 'https://als.moja.example',
  quotingEndpoint: 'https://quoting.moja.example',
  transfersEndpoint: 'https://transfers.moja.example',
  dfspId: 'agric-dfsp'
};

const LIVE_ENV: NodeJS.ProcessEnv = {
  MOJALOOP_DRIVER: 'live',
  MOJALOOP_ALS_ENDPOINT: CONFIG.alsEndpoint,
  MOJALOOP_QUOTING_ENDPOINT: CONFIG.quotingEndpoint,
  MOJALOOP_TRANSFERS_ENDPOINT: CONFIG.transfersEndpoint,
  MOJALOOP_DFSP_ID: CONFIG.dfspId
};

const QUOTE_INPUT: MojaloopQuoteInput = {
  amountNaira: 12_500,
  payerMsisdn: '2348012345678',
  payeeMsisdn: '2348098765432',
  reference: 'pay-1'
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

describe('createMojaloopAdapter live selection', () => {
  it('keeps the stub as the default when MOJALOOP_DRIVER is unset', () => {
    expect(createMojaloopAdapter({}).name).toBe('stub');
  });

  it('builds the live driver when all three FSPIOP endpoints are set', () => {
    const adapter = createMojaloopAdapter(LIVE_ENV);
    expect(adapter.name).toBe('live');
  });

  it('fails closed when any live endpoint is missing (any environment)', () => {
    for (const omitted of [
      'MOJALOOP_ALS_ENDPOINT',
      'MOJALOOP_QUOTING_ENDPOINT',
      'MOJALOOP_TRANSFERS_ENDPOINT'
    ]) {
      const env = { ...LIVE_ENV };
      delete env[omitted];
      expect(() => createMojaloopAdapter(env)).toThrow(ProviderConfigError);
    }
  });

  it('refuses placeholder endpoints in production', () => {
    expect(() =>
      createMojaloopAdapter({
        ...LIVE_ENV,
        NODE_ENV: 'production',
        MOJALOOP_ALS_ENDPOINT: 'http://localhost:4002'
      })
    ).toThrow(ProviderConfigError);
    expect(() =>
      createMojaloopAdapter({
        ...LIVE_ENV,
        NODE_ENV: 'production',
        MOJALOOP_TRANSFERS_ENDPOINT: 'https://changeme'
      })
    ).toThrow(ProviderConfigError);
  });

  it('accepts real-looking https endpoints in production', () => {
    const adapter = createMojaloopAdapter({ ...LIVE_ENV, NODE_ENV: 'production' });
    expect(adapter.name).toBe('live');
  });

  it('allows loopback endpoints outside production (local scheme adapter)', () => {
    const adapter = createMojaloopAdapter({
      ...LIVE_ENV,
      MOJALOOP_ALS_ENDPOINT: 'http://localhost:4002'
    });
    expect(adapter.name).toBe('live');
  });
});

describe('LiveMojaloopDriver', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('looks up a party via the ALS GET /parties/{idType}/{idValue}', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({
        party: {
          partyIdInfo: { fspId: 'payee-dfsp' },
          personalInfo: { complexName: { firstName: 'Ada', lastName: 'Lovelace' } }
        }
      })
    );
    const driver = new LiveMojaloopDriver(CONFIG);
    const party = await driver.lookupParty('MSISDN', '2348098765432');
    expect(party.fspId).toBe('payee-dfsp');
    expect(party.displayName).toBe('Ada Lovelace');
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://als.moja.example/parties/MSISDN/2348098765432');
    expect((init.method ?? 'GET')).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.accept).toContain('application/vnd.interoperability.parties+json');
    expect(headers['fspiop-source']).toBe('agric-dfsp');
    expect(headers['fspiop-signature']).toBeUndefined(); // unsigned without a configured key
  });

  it('requests a quote via POST /quotes with a deterministic transaction id', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({
        quoteId: 'q-7',
        transferAmount: { amount: '12500' },
        payeeFspFee: { amount: '25' }
      })
    );
    const driver = new LiveMojaloopDriver(CONFIG);
    const quote = await driver.requestQuote(QUOTE_INPUT);
    expect(quote).toMatchObject({
      quoteId: 'q-7',
      amountNaira: 12_500,
      feeNaira: 25,
      status: 'received'
    });
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://quoting.moja.example/quotes');
    const body = JSON.parse(init.body as string) as { transactionId: string };
    expect(body.transactionId).toBe(LiveMojaloopDriver.transactionIdFor(QUOTE_INPUT.reference));
  });

  it('prepares a transfer with an ILP condition and maps COMMITTED', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ transferId: 't-9', transferState: 'COMMITTED', fulfilment: 'f' })
    );
    const driver = new LiveMojaloopDriver(CONFIG);
    const transfer = await driver.executeTransfer({
      ...QUOTE_INPUT,
      quoteId: 'q-7',
      condition: 'quote-supplied-condition'
    });
    expect(transfer.status).toBe('committed');
    expect(transfer.transferId).toBe('t-9');
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://transfers.moja.example/transfers');
    const body = JSON.parse(init.body as string) as {
      transferId: string;
      condition: string;
      payerFsp: string;
    };
    expect(body.condition).toBe('quote-supplied-condition');
    expect(body.payerFsp).toBe('agric-dfsp');
    expect(body.transferId).toBe(LiveMojaloopDriver.transferIdFor(QUOTE_INPUT.reference));
  });

  it('is idempotent: retries replay the recorded outcome without re-posting', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ transferState: 'COMMITTED', fulfilment: 'f' })
    );
    const driver = new LiveMojaloopDriver(CONFIG);
    const input = { ...QUOTE_INPUT, quoteId: 'q-7' };
    const first = await driver.executeTransfer(input);
    const second = await driver.executeTransfer({ ...input });
    const concurrent = await Promise.all([
      driver.executeTransfer({ ...input }),
      driver.executeTransfer({ ...input })
    ]);
    expect(second).toEqual(first);
    expect(concurrent[0]).toEqual(first);
    expect(concurrent[1]).toEqual(first);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(LiveMojaloopDriver.transferIdFor(input.reference)).toBe(first.transferId);
  });

  it('queries transfer status via GET /transfers/{id}', async () => {
    fetchMock().mockResolvedValue(jsonResponse({ transferState: 'COMMITTED' }));
    const driver = new LiveMojaloopDriver(CONFIG);
    const transfer = await driver.transferStatus('t-9');
    expect(transfer.status).toBe('committed');
    const [url] = fetchMock().mock.calls[0] as [string];
    expect(url).toBe('https://transfers.moja.example/transfers/t-9');
  });

  it('completes the transfer on an inbound fulfil callback', () => {
    const driver = new LiveMojaloopDriver(CONFIG);
    const transfer = driver.handleTransferCallback('t-9', {
      transferState: 'COMMITTED',
      fulfilment: 'x'
    });
    expect(transfer.status).toBe('committed');
    const aborted = driver.handleTransferCallback('t-10', { transferState: 'ABORTED' });
    expect(aborted.status).toBe('failed');
  });

  it('fails closed on a fulfilment that does not match a self-generated ILP condition', async () => {
    fetchMock().mockResolvedValue(jsonResponse({ transferState: 'RECEIVED' }));
    const driver = new LiveMojaloopDriver(CONFIG);
    const input = { ...QUOTE_INPUT, quoteId: 'q-7' }; // no condition → driver generates one
    const prepared = await driver.executeTransfer(input);
    expect(() =>
      driver.handleTransferCallback(prepared.transferId, {
        transferState: 'COMMITTED',
        fulfilment: Buffer.from('wrong-preimage').toString('base64url')
      })
    ).toThrow(/fulfilment/);
  });

  it('maps HTTP errors to ProviderHttpError and opens the circuit', async () => {
    fetchMock().mockImplementation(() => Promise.resolve(new Response('down', { status: 502 })));
    const driver = new LiveMojaloopDriver(CONFIG);
    for (let i = 0; i < MOJALOOP_CIRCUIT_THRESHOLD; i += 1) {
      await expect(driver.requestQuote(QUOTE_INPUT)).rejects.toBeInstanceOf(ProviderHttpError);
    }
    expect(driver.circuitOpen).toBe(true);
    const callsBefore = fetchMock().mock.calls.length;
    await expect(driver.requestQuote(QUOTE_INPUT)).rejects.toBeInstanceOf(ProviderRequestError);
    expect(fetchMock().mock.calls.length).toBe(callsBefore);
  });

  it('maps transport failures to ProviderRequestError', async () => {
    fetchMock().mockRejectedValue(new Error('connection refused'));
    const driver = new LiveMojaloopDriver(CONFIG);
    await expect(driver.requestQuote(QUOTE_INPUT)).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it('wraps outbound calls in telemetry spans and counters (no account PII)', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ quoteId: 'q-1', transferAmount: { amount: '12500' } })
    );
    const telemetry = new TelemetryService();
    const withSpan = vi.spyOn(telemetry, 'withSpan');
    const record = vi.spyOn(telemetry, 'record');
    const driver = new LiveMojaloopDriver(CONFIG, telemetry);
    await driver.requestQuote(QUOTE_INPUT);
    expect(withSpan).toHaveBeenCalledWith(
      'mojaloop.quote',
      expect.objectContaining({ dfsp: 'agric-dfsp', operation: 'quote' }),
      expect.any(Function)
    );
    const spanAttrs = withSpan.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(spanAttrs)).not.toContain(QUOTE_INPUT.payerMsisdn);
    expect(JSON.stringify(spanAttrs)).not.toContain(QUOTE_INPUT.payeeMsisdn);
    expect(record).toHaveBeenCalledWith(
      'mojaloop.request.duration_ms',
      expect.any(Number),
      expect.objectContaining({ dfsp: 'agric-dfsp', operation: 'quote', status: 'ok' })
    );
  });

  it('increments the error counter on failure', async () => {
    fetchMock().mockImplementation(() => Promise.resolve(new Response('down', { status: 500 })));
    const telemetry = new TelemetryService();
    const increment = vi.spyOn(telemetry, 'increment');
    const driver = new LiveMojaloopDriver(CONFIG, telemetry);
    await expect(driver.requestQuote(QUOTE_INPUT)).rejects.toBeInstanceOf(ProviderHttpError);
    expect(increment).toHaveBeenCalledWith(
      'mojaloop.errors.total',
      1,
      expect.objectContaining({ dfsp: 'agric-dfsp', operation: 'quote', status: 'error' })
    );
  });

  it('reports the honest security posture in status()', async () => {
    const unsigned = await new LiveMojaloopDriver(CONFIG).status();
    expect(unsigned.detail).toContain('jws:unsigned');
    const signed = await new LiveMojaloopDriver({
      ...CONFIG,
      jwsSigningKeyPath: '/keys/dfsp.pem'
    }).status();
    expect(signed.detail).toContain('jws:configured');
  });
});

describe('LiveMojaloopDriver JWS signing', () => {
  let keyDir: string;
  let keyPath: string;

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn());
    keyDir = await mkdtemp(join(tmpdir(), 'mojaloop-jws-'));
    const { privateKey } = await generateKeyPair('PS256', { extractable: true });
    keyPath = join(keyDir, 'dfsp.pem');
    await writeFile(keyPath, await exportPKCS8(privateKey), 'utf8');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(keyDir, { recursive: true, force: true });
  });

  it('attaches a detached-payload PS256 fspiop-signature only when a key is configured', async () => {
    fetchMock().mockResolvedValue(
      jsonResponse({ quoteId: 'q-1', transferAmount: { amount: '12500' } })
    );
    const driver = new LiveMojaloopDriver({ ...CONFIG, jwsSigningKeyPath: keyPath });
    await driver.requestQuote(QUOTE_INPUT);
    const [, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const signature = headers['fspiop-signature'];
    expect(signature).toBeDefined();
    const parts = signature.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[1]).toBe(''); // detached payload form
    const protectedHeader = JSON.parse(
      Buffer.from(parts[0] as string, 'base64url').toString('utf8')
    ) as { alg: string; 'FSPIOP-HTTP-Method': string; 'FSPIOP-URI': string };
    expect(protectedHeader.alg).toBe('PS256');
    expect(protectedHeader['FSPIOP-HTTP-Method']).toBe('POST');
    expect(protectedHeader['FSPIOP-URI']).toBe('/quotes');
  });
});
