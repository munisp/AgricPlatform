import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigError, ProviderHttpError } from './http.js';
import { createWhatsAppDriver, Dialog360WhatsAppDriver } from './whatsapp.drivers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Dialog360WhatsAppDriver', () => {
  it('sends a template message with the D360-API-KEY header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [{ id: 'wamid.1' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new Dialog360WhatsAppDriver('d360-key', 'ns');
    const result = await driver.sendTemplate({
      to: '2348000000001',
      template: 'opportunity_alert',
      bodyParams: ['Ada', 'Rice']
    });
    expect(result).toMatchObject({ delivered: true, providerRef: 'wamid.1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://waba.360dialog.io/v1/messages');
    expect((init.headers as Record<string, string>)['D360-API-KEY']).toBe('d360-key');
    const body = JSON.parse(init.body as string);
    expect(body.template.name).toBe('opportunity_alert');
    expect(body.template.components[0].parameters).toHaveLength(2);
  });

  it('sends a free-form text message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [{ id: 'wamid.2' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new Dialog360WhatsAppDriver('d360-key', undefined);
    const result = await driver.sendText({ to: '2348000000001', message: 'Hello' });
    expect(result.providerRef).toBe('wamid.2');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).text.body).toBe('Hello');
  });

  it('maps provider rejections to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unauthorized', { status: 403 })));
    const driver = new Dialog360WhatsAppDriver('bad', undefined);
    await expect(driver.sendTemplate({ to: '1', template: 'x' })).rejects.toThrow(ProviderHttpError);
  });
});

describe('inbound webhook normalisation', () => {
  const driver = new Dialog360WhatsAppDriver('k', undefined);

  it('extracts messages from the Cloud-API entry/changes envelope', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.in1',
                    from: '2348000000001',
                    timestamp: '1735000000',
                    type: 'text',
                    text: { body: 'STOP' }
                  }
                ]
              }
            }
          ]
        }
      ]
    };
    expect(driver.normalizeInboundWebhook(payload)).toEqual([
      {
        providerMessageId: 'wamid.in1',
        from: '2348000000001',
        timestamp: '1735000000',
        type: 'text',
        text: 'STOP'
      }
    ]);
  });

  it('accepts flat sandbox payloads without the envelope', () => {
    const payload = { messages: [{ id: 'm1', from: '234', type: 'text', text: { body: 'hi' } }] };
    const [message] = driver.normalizeInboundWebhook(payload);
    expect(message.providerMessageId).toBe('m1');
    expect(message.text).toBe('hi');
  });

  it('returns an empty list for status-only or malformed payloads', () => {
    expect(driver.normalizeInboundWebhook({ entry: [{ changes: [{ value: { statuses: [] } }] }] })).toEqual([]);
    expect(driver.normalizeInboundWebhook(undefined)).toEqual([]);
    expect(driver.normalizeInboundWebhook({ messages: [{ from: 'x' }] })).toEqual([]);
  });
});

describe('createWhatsAppDriver factory (fail closed)', () => {
  it('throws without the API key', () => {
    expect(() => createWhatsAppDriver({})).toThrow(ProviderConfigError);
  });

  it('builds the driver with key and optional namespace', () => {
    const driver = createWhatsAppDriver({
      WHATSAPP_360DIALOG_API_KEY: 'k',
      WHATSAPP_360DIALOG_NAMESPACE: 'ns'
    });
    expect(driver).toBeInstanceOf(Dialog360WhatsAppDriver);
    expect(driver.namespace).toBe('ns');
  });
});
