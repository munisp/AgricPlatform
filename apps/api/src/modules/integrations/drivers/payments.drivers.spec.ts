import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigError, ProviderHttpError } from './http.js';
import {
  createPaymentDriver,
  FlutterwavePaymentDriver,
  PaystackPaymentDriver,
  verifyFlutterwaveSignature,
  verifyPaystackSignature
} from './payments.drivers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PaystackPaymentDriver', () => {
  it('initialises a transaction in kobo with the bearer secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        status: true,
        data: { authorization_url: 'https://pay.url/x', reference: 'ref-1', access_code: 'ac-1' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const driver = new PaystackPaymentDriver('sk_test');
    const result = await driver.initializeTransaction({
      amountNaira: 2500,
      email: 'farmer@example.com',
      reference: 'ref-1'
    });
    expect(result).toEqual({
      reference: 'ref-1',
      authorizationUrl: 'https://pay.url/x',
      providerRef: 'ac-1'
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.paystack.co/transaction/initialize');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk_test');
    expect(JSON.parse(init.body as string).amount).toBe(250000);
  });

  it('verifies transactions and converts kobo back to naira', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ status: true, data: { status: 'success', amount: 250000, paid_at: '2025-01-01', id: 7 } })
      )
    );
    const driver = new PaystackPaymentDriver('sk_test');
    const result = await driver.verifyTransaction('ref-1');
    expect(result).toMatchObject({ status: 'success', amountNaira: 2500, providerRef: '7' });
  });

  it('maps pending and abandoned verification states', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ status: true, data: { status: 'abandoned' } }))
    );
    const driver = new PaystackPaymentDriver('sk_test');
    expect((await driver.verifyTransaction('ref-x')).status).toBe('failed');
  });

  it('creates refunds against the transaction reference', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: true, data: { id: 99, status: 'pending' } }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new PaystackPaymentDriver('sk_test');
    const result = await driver.refund('ref-1', 1000);
    expect(result).toMatchObject({ providerRef: '99', status: 'pending' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ transaction: 'ref-1', amount: 100000 });
  });

  it('releases escrow via the transfer rail', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ status: true, data: { transfer_code: 'TRF_1', status: 'pending' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const driver = new PaystackPaymentDriver('sk_test');
    const result = await driver.transfer({
      amountNaira: 5000,
      recipient: 'RCP_abc',
      reference: 'escrow-1'
    });
    expect(result.providerRef).toBe('TRF_1');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ source: 'balance', amount: 500000, recipient: 'RCP_abc' });
  });

  it('maps 5xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('gateway', { status: 502 })));
    const driver = new PaystackPaymentDriver('sk_test');
    await expect(driver.verifyTransaction('ref')).rejects.toThrow(ProviderHttpError);
  });
});

describe('FlutterwavePaymentDriver', () => {
  it('initialises a payment link', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ status: 'success', data: { link: 'https://flw.url/pay', id: 11 } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const driver = new FlutterwavePaymentDriver('flw_sk');
    const result = await driver.initializeTransaction({
      amountNaira: 1200,
      email: 'f@example.com',
      reference: 'tx-1'
    });
    expect(result.authorizationUrl).toBe('https://flw.url/pay');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ tx_ref: 'tx-1', amount: 1200, currency: 'NGN' });
  });

  it('verifies by tx_ref and maps successful→success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ status: 'success', data: { status: 'successful', amount: 1200, id: 11 } })
    ));
    const driver = new FlutterwavePaymentDriver('flw_sk');
    const result = await driver.verifyTransaction('tx-1');
    expect(result).toMatchObject({ status: 'success', amountNaira: 1200 });
  });

  it('refunds by transaction id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ status: 'success', data: { id: 11, status: 'completed' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const driver = new FlutterwavePaymentDriver('flw_sk');
    const result = await driver.refund('11', 500);
    expect(result.status).toBe('success');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.flutterwave.com/v3/transactions/11/refund');
  });

  it('disburses transfers from bankCode:accountNumber recipients', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ status: 'success', data: { id: 21, status: 'NEW' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const driver = new FlutterwavePaymentDriver('flw_sk');
    const result = await driver.transfer({
      amountNaira: 3000,
      recipient: '044:0690000031',
      reference: 'esc-2'
    });
    expect(result.status).toBe('pending');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      account_bank: '044',
      account_number: '0690000031',
      amount: 3000
    });
  });

  it('rejects malformed transfer recipients without a network call', async () => {
    const driver = new FlutterwavePaymentDriver('flw_sk');
    await expect(
      driver.transfer({ amountNaira: 1, recipient: 'bad', reference: 'r' })
    ).rejects.toThrow(/bankCode:accountNumber/);
  });

  it('maps 4xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 401 })));
    const driver = new FlutterwavePaymentDriver('flw_sk');
    await expect(driver.verifyTransaction('x')).rejects.toThrow(ProviderHttpError);
  });
});

describe('webhook signature helpers', () => {
  it('verifies Paystack HMAC-SHA512 signatures over the raw body', () => {
    const body = Buffer.from(JSON.stringify({ event: 'charge.success' }));
    const signature = createHmac('sha512', 'sk_example_fake').update(body).digest('hex');
    expect(verifyPaystackSignature(body, 'sk_example_fake', signature)).toBe(true);
    expect(verifyPaystackSignature(body, 'sk_example_fake', 'deadbeef'.repeat(8))).toBe(false);
    expect(verifyPaystackSignature(body, 'sk_example_fake', undefined)).toBe(false);
  });

  it('verifies the Flutterwave verif-hash header with constant-time compare', () => {
    expect(verifyFlutterwaveSignature('my-hash', 'my-hash')).toBe(true);
    expect(verifyFlutterwaveSignature('my-hash', 'other')).toBe(false);
    expect(verifyFlutterwaveSignature('my-hash', undefined)).toBe(false);
  });
});

describe('createPaymentDriver factory (fail closed)', () => {
  it('requires the provider secret key', () => {
    expect(() => createPaymentDriver('paystack', {})).toThrow(ProviderConfigError);
    expect(() => createPaymentDriver('flutterwave', {})).toThrow(/FLUTTERWAVE_SECRET_KEY/);
  });

  it('builds each driver with its secret key', () => {
    expect(createPaymentDriver('paystack', { PAYSTACK_SECRET_KEY: 'sk' })).toBeInstanceOf(
      PaystackPaymentDriver
    );
    expect(createPaymentDriver('flutterwave', { FLUTTERWAVE_SECRET_KEY: 'sk' })).toBeInstanceOf(
      FlutterwavePaymentDriver
    );
  });
});
