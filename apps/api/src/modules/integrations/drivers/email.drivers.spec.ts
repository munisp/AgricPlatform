import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigError, ProviderHttpError } from './http.js';
import {
  createEmailDriver,
  MailgunEmailDriver,
  SendGridEmailDriver
} from './email.drivers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MailgunEmailDriver', () => {
  it('posts a form payload with basic auth to the domain messages endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: '<msg@mg>', message: 'Queued' }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new MailgunEmailDriver('mg-key', 'mg.agricplatform.ng', 'no-reply@agricplatform.ng');
    const result = await driver.send({
      to: 'farmer@example.com',
      subject: 'Welcome',
      text: 'Plain',
      html: '<p>Html</p>'
    });
    expect(result).toMatchObject({ delivered: true, provider: 'mailgun', providerRef: '<msg@mg>' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mailgun.net/v3/mg.agricplatform.ng/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('api:mg-key').toString('base64')}`);
    const body = init.body as string;
    expect(body).toContain('subject=Welcome');
    expect(decodeURIComponent(body)).toContain('html=<p>Html</p>');
  });

  it('maps 4xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('forbidden', { status: 401 })));
    const driver = new MailgunEmailDriver('bad', 'd', 'from@x');
    await expect(driver.send({ to: 'a@b', subject: 's', text: 't' })).rejects.toThrow(
      ProviderHttpError
    );
  });
});

describe('SendGridEmailDriver', () => {
  it('posts the v3 mail/send payload with a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new SendGridEmailDriver('sg-key', 'no-reply@agricplatform.ng');
    const result = await driver.send({ to: 'farmer@example.com', subject: 'Hi', text: 'Body' });
    expect(result.delivered).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sg-key');
    const body = JSON.parse(init.body as string);
    expect(body.personalizations[0].to[0].email).toBe('farmer@example.com');
    expect(body.content[0]).toEqual({ type: 'text/plain', value: 'Body' });
  });

  it('maps 5xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('oops', { status: 500 })));
    const driver = new SendGridEmailDriver('k', 'f@x');
    await expect(driver.send({ to: 'a@b', subject: 's', text: 't' })).rejects.toMatchObject({
      status: 500
    });
  });
});

describe('createEmailDriver factory (fail closed)', () => {
  it('throws when neither provider is configured', () => {
    expect(() => createEmailDriver({})).toThrow(ProviderConfigError);
    expect(() => createEmailDriver({ MAILGUN_API_KEY: 'k' })).toThrow(/MAILGUN_DOMAIN/);
  });

  it('prefers Mailgun when fully configured', () => {
    expect(
      createEmailDriver({ MAILGUN_API_KEY: 'k', MAILGUN_DOMAIN: 'd', SENDGRID_API_KEY: 's' })
    ).toBeInstanceOf(MailgunEmailDriver);
  });

  it('falls back to SendGrid when Mailgun is incomplete', () => {
    expect(createEmailDriver({ SENDGRID_API_KEY: 's' })).toBeInstanceOf(SendGridEmailDriver);
  });
});
