import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigError, ProviderHttpError, ProviderRequestError } from './http.js';
import {
  createMojaloopAdapter,
  MOJALOOP_CIRCUIT_THRESHOLD,
  MojaloopSimulatorAdapter,
  StubMojaloopAdapter,
  type MojaloopQuoteInput
} from './mojaloop.driver.js';

const QUOTE_INPUT: MojaloopQuoteInput = {
  amountNaira: 12_500,
  payerMsisdn: '2348012345678',
  payeeMsisdn: '2348098765432',
  reference: 'pay-1'
};

describe('StubMojaloopAdapter (default — simulated fixtures)', () => {
  const adapter = new StubMojaloopAdapter();

  it('is deterministic per quote input and clearly labelled', async () => {
    const a = await adapter.requestQuote(QUOTE_INPUT);
    const b = await adapter.requestQuote({ ...QUOTE_INPUT });
    expect(a).toEqual(b);
    expect(a.status).toBe('simulated');
    expect(a.source).toContain('stub-fixture');
    expect(a.source).toContain('not a Mojaloop switch quote');
  });

  it('returns simulated transfers that move no funds', async () => {
    const transfer = await adapter.executeTransfer({ ...QUOTE_INPUT, quoteId: 'q-1' });
    expect(transfer.status).toBe('simulated');
    expect(transfer.source).toContain('no funds moved');
  });
});

describe('createMojaloopAdapter selection', () => {
  it('defaults to the stub when MOJALOOP_DRIVER is unset', () => {
    expect(createMojaloopAdapter({}).name).toBe('stub');
  });

  it('fails closed when simulator is selected without MOJALOOP_SIM_URL', () => {
    expect(() => createMojaloopAdapter({ MOJALOOP_DRIVER: 'simulator' })).toThrow(
      ProviderConfigError
    );
  });

  it('builds the simulator adapter with the URL (trailing slash trimmed)', () => {
    const adapter = createMojaloopAdapter({
      MOJALOOP_DRIVER: 'simulator',
      MOJALOOP_SIM_URL: 'http://localhost:4044/'
    });
    expect(adapter.name).toBe('simulator');
  });
});

describe('MojaloopSimulatorAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

  it('requests a quote via FSPIOP-shaped POST /quotes', async () => {
    fetchMock().mockResolvedValue(
      new Response(
        JSON.stringify({
          quoteId: 'q-7',
          transferAmount: { amount: '12500' },
          payeeFspFee: { amount: '25' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const adapter = new MojaloopSimulatorAdapter('http://sim:4044');
    const quote = await adapter.requestQuote(QUOTE_INPUT);
    expect(quote).toEqual({
      quoteId: 'q-7',
      reference: 'pay-1',
      amountNaira: 12_500,
      feeNaira: 25,
      status: 'received',
      source: expect.stringContaining('mojaloop simulator')
    });
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://sim:4044/quotes');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toContain('application/vnd.interoperability.quotes+json');
    const body = JSON.parse(init.body as string) as { amount: { currency: string; amount: string } };
    expect(body.amount).toEqual({ currency: 'NGN', amount: '12500' });
  });

  it('maps a COMMITTED simulator transfer to committed', async () => {
    fetchMock().mockResolvedValue(
      new Response(
        JSON.stringify({ transferId: 't-9', transferState: 'COMMITTED', fulfilment: 'f' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const adapter = new MojaloopSimulatorAdapter('http://sim:4044');
    const transfer = await adapter.executeTransfer({ ...QUOTE_INPUT, quoteId: 'q-7' });
    expect(transfer.status).toBe('committed');
    expect(transfer.transferId).toBe('t-9');
    const [url] = fetchMock().mock.calls[0] as [string];
    expect(url).toBe('http://sim:4044/transfers');
  });

  it('fails closed on HTTP errors and opens the circuit after consecutive failures', async () => {
    fetchMock().mockImplementation(() => Promise.resolve(new Response('down', { status: 502 })));
    const adapter = new MojaloopSimulatorAdapter('http://sim:4044');
    for (let i = 0; i < MOJALOOP_CIRCUIT_THRESHOLD; i += 1) {
      await expect(adapter.requestQuote(QUOTE_INPUT)).rejects.toBeInstanceOf(ProviderHttpError);
    }
    expect(adapter.circuitOpen).toBe(true);
    const callsBefore = fetchMock().mock.calls.length;
    await expect(adapter.requestQuote(QUOTE_INPUT)).rejects.toBeInstanceOf(ProviderRequestError);
    expect(fetchMock().mock.calls.length).toBe(callsBefore);
  });
});
