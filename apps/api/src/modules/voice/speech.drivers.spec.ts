import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigError, ProviderRequestError } from '../integrations/drivers/http.js';
import {
  ASR_CIRCUIT_THRESHOLD,
  createSpeechProvider,
  HttpSpeechProvider,
  StubSpeechProvider
} from './speech.drivers.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createSpeechProvider — fail-closed factory', () => {
  it('defaults to the stub driver', () => {
    expect(createSpeechProvider({} as NodeJS.ProcessEnv).name).toBe('stub');
    expect(createSpeechProvider({ ASR_DRIVER: 'stub' } as NodeJS.ProcessEnv).name).toBe('stub');
  });

  it('http without ASR_PROVIDER_URL fails closed with ProviderConfigError', () => {
    expect(() => createSpeechProvider({ ASR_DRIVER: 'http' } as NodeJS.ProcessEnv)).toThrow(
      ProviderConfigError
    );
  });

  it('http with a URL builds the live driver', () => {
    const provider = createSpeechProvider({
      ASR_DRIVER: 'http',
      ASR_PROVIDER_URL: 'http://asr.local:9000/'
    } as NodeJS.ProcessEnv);
    expect(provider.name).toBe('http');
  });
});

describe('StubSpeechProvider', () => {
  it('passes text through unchanged, labelled as no-ASR', async () => {
    const provider = new StubSpeechProvider();
    const result = await provider.transcribe({ text: '  my maize has worms  ', locale: 'en' });
    expect(result.text).toBe('my maize has worms');
    expect(result.confidence).toBe(1);
    expect(result.source).toContain('stub');
  });

  it('audio-only input yields a SIMULATED low-confidence transcript', async () => {
    const provider = new StubSpeechProvider();
    const result = await provider.transcribe({ audioUrl: 'https://calls.example/rec-1.mp3', locale: 'en' });
    expect(result.text).toContain('simulated transcript');
    expect(result.confidence).toBeLessThan(0.35);
    expect(result.source).toContain('SIMULATED');
  });

  it('is deterministic — same input, same transcript', async () => {
    const provider = new StubSpeechProvider();
    const a = await provider.transcribe({ audioUrl: 'https://calls.example/rec-1.mp3', locale: 'en' });
    const b = await provider.transcribe({ audioUrl: 'https://calls.example/rec-1.mp3', locale: 'en' });
    expect(a).toEqual(b);
  });
});

describe('HttpSpeechProvider — live mode semantics', () => {
  function jsonResponse(body: unknown, status = 200): Promise<Response> {
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    );
  }

  it('posts to /transcribe with the bearer key and maps the response', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ text: 'maize worms', confidence: 0.9 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new HttpSpeechProvider('http://asr.local:9000', 'secret');
    const result = await provider.transcribe({ audioUrl: 'https://x/rec.mp3', locale: 'en' });
    expect(result.text).toBe('maize worms');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://asr.local:9000/transcribe');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
  });

  it('network failure raises ProviderRequestError (caller maps to 503) — never stub fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const provider = new HttpSpeechProvider('http://asr.local:9000');
    await expect(provider.transcribe({ audioUrl: 'https://x/r.mp3', locale: 'en' })).rejects.toBeInstanceOf(
      ProviderRequestError
    );
  });

  it('opens the circuit after consecutive failures and fails fast', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new HttpSpeechProvider('http://asr.local:9000');
    for (let i = 0; i < ASR_CIRCUIT_THRESHOLD; i += 1) {
      await expect(provider.transcribe({ audioUrl: 'a', locale: 'en' })).rejects.toBeInstanceOf(
        ProviderRequestError
      );
    }
    expect(provider.circuitOpen).toBe(true);
    const callsBefore = fetchMock.mock.calls.length;
    await expect(provider.transcribe({ audioUrl: 'a', locale: 'en' })).rejects.toBeInstanceOf(
      ProviderRequestError
    );
    expect(fetchMock.mock.calls.length).toBe(callsBefore); // fail fast, no new request
  });
});
