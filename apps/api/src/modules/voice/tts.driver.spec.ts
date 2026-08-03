import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigError, ProviderRequestError } from '../integrations/drivers/http.js';
import {
  createTtsDriver,
  escapeSsml,
  HttpTtsDriver,
  StubTtsDriver
} from './tts.driver.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createTtsDriver — fail-closed factory', () => {
  it('defaults to the stub driver', () => {
    expect(createTtsDriver({} as NodeJS.ProcessEnv).name).toBe('stub');
  });

  it('http without TTS_PROVIDER_URL fails closed with ProviderConfigError', () => {
    expect(() => createTtsDriver({ TTS_DRIVER: 'http' } as NodeJS.ProcessEnv)).toThrow(
      ProviderConfigError
    );
  });

  it('http with a URL builds the live driver', () => {
    expect(
      createTtsDriver({ TTS_DRIVER: 'http', TTS_PROVIDER_URL: 'http://tts.local:9001' } as NodeJS.ProcessEnv).name
    ).toBe('http');
  });
});

describe('StubTtsDriver', () => {
  it('returns SSML for the IVR provider to speak, labelled as unsynthesized', async () => {
    const driver = new StubTtsDriver();
    const speech = await driver.synthesize({ text: 'Plant maize after rainfall onset.', locale: 'en' });
    expect(speech.ssml).toBe('<speak xml:lang="en">Plant maize after rainfall onset.</speak>');
    expect(speech.audioUrl).toBeUndefined();
    expect(speech.source).toContain('stub');
    expect(speech.source).toContain('no audio synthesized');
  });

  it('escapes SSML special characters', () => {
    expect(escapeSsml(`a <b> & "c" 'd'`)).toBe('a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos;');
  });
});

describe('HttpTtsDriver — live mode semantics', () => {
  it('maps the provider response and never falls back to the stub on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ssml: '<speak>hi</speak>', audio_url: 'https://cdn/x.mp3' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );
    const driver = new HttpTtsDriver('http://tts.local:9001');
    const speech = await driver.synthesize({ text: 'hi', locale: 'en' });
    expect(speech.ssml).toBe('<speak>hi</speak>');
    expect(speech.audioUrl).toBe('https://cdn/x.mp3');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const failing = new HttpTtsDriver('http://tts.local:9001');
    await expect(failing.synthesize({ text: 'hi', locale: 'en' })).rejects.toBeInstanceOf(
      ProviderRequestError
    );
  });
});
