import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFieldDataSources,
  fieldDataDriverEnabled,
  KoboToolboxClient,
  OdkCentralClient,
  SftpFieldDataScaffold
} from './field-data.clients.js';
import { ProviderConfigError, ProviderHttpError } from './http.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function hangingFetch() {
  return (_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted', 'AbortError'))
      );
    });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('KoboToolboxClient', () => {
  const client = () => new KoboToolboxClient('https://kobo.example.com', 'tok', 'asset-1');

  it('fetches asset submissions with the token header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ results: [{ name: 'Amina', phone: '0801' }] })
    );
    vi.stubGlobal('fetch', fetchMock);
    const rows = await client().fetchSubmissions();
    expect(rows).toEqual([{ name: 'Amina', phone: '0801' }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://kobo.example.com/api/v2/assets/asset-1/data.json');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Token tok');
  });

  it('maps 4xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 404 })));
    await expect(client().fetchSubmissions()).rejects.toThrow(ProviderHttpError);
  });

  it('maps 5xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 500 })));
    await expect(client().fetchSubmissions()).rejects.toThrow(ProviderHttpError);
  });

  it('maps timeouts to ProviderRequestError(timeout)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const assertion = expect(client().fetchSubmissions()).rejects.toMatchObject({
      name: 'ProviderRequestError',
      reason: 'timeout'
    });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});

describe('OdkCentralClient', () => {
  it('fetches submissions from the OData-style envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ value: [{ nin: '123', consent_date: '2026-04-01' }] })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new OdkCentralClient('https://odk.example.com', 'btok', '3', 'form-9');
    const rows = await client.fetchSubmissions();
    expect(rows).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://odk.example.com/v1/projects/3/forms/form-9/submissions');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer btok');
  });
});

describe('SftpFieldDataScaffold (fail closed)', () => {
  it('refuses to pull until the SFTP transport is approved', () => {
    const scaffold = new SftpFieldDataScaffold('sftp.partner.example', 'drop');
    expect(() => scaffold.fetchSubmissions()).toThrow(ProviderConfigError);
  });
});

describe('createFieldDataSources (fail closed)', () => {
  it('returns no sources while the driver is stub', () => {
    expect(createFieldDataSources({ FIELD_DATA_DRIVER: 'stub' })).toEqual([]);
    expect(fieldDataDriverEnabled({ FIELD_DATA_DRIVER: 'stub' })).toBe(false);
  });

  it('raises ProviderConfigError when a source is partially keyed', () => {
    expect(() =>
      createFieldDataSources({ FIELD_DATA_DRIVER: 'live', KOBO_BASE_URL: 'https://k.example' })
    ).toThrow(ProviderConfigError);
  });

  it('fails closed on an SFTP configuration until transport approval', () => {
    expect(() =>
      createFieldDataSources({ FIELD_DATA_DRIVER: 'live', FIELD_DATA_SFTP_HOST: 'sftp.example' })
    ).toThrow(ProviderConfigError);
  });

  it('builds keyed sources and enables the driver', () => {
    const env = {
      FIELD_DATA_DRIVER: 'live',
      KOBO_BASE_URL: 'https://k.example',
      KOBO_API_TOKEN: 't',
      KOBO_ASSET_UID: 'a'
    };
    expect(createFieldDataSources(env)).toHaveLength(1);
    expect(fieldDataDriverEnabled(env)).toBe(true);
  });
});
