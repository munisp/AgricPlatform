/**
 * TTS driver port (wave VOICE). The STUB driver is the default: it returns
 * SSML wrapping the reply text for the IVR provider to speak — no audio is
 * synthesized, and the output is labelled as such. TTS_DRIVER=http selects
 * the live provider behind TTS_PROVIDER_URL (+ optional TTS_API_KEY
 * bearer); the factory fails closed with ProviderConfigError when http is
 * selected without a URL, and the live driver raises ProviderRequestError
 * (mapped to 503) when unreachable — never a silent fallback to the stub.
 * Same doctrine as speech.drivers.ts / geo-intel flood-risk.drivers.ts.
 */
import {
  httpJson,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  requireEnv
} from '../integrations/drivers/http.js';

/** Consecutive provider failures before the circuit opens. */
export const TTS_CIRCUIT_THRESHOLD = 3;
/** How long the circuit stays open before the next call is allowed through. */
export const TTS_CIRCUIT_COOLDOWN_MS = 30_000;
/** Live synthesis timeout (mirrors the shared 5s provider default). */
export const TTS_TIMEOUT_MS = 5_000;

export interface TtsSynthesizeInput {
  text: string;
  locale: string;
}

export interface TtsSpeech {
  /** SSML for the IVR provider to render (always present). */
  ssml: string;
  /** Synthesized audio URL (live driver only, when the provider returns one). */
  audioUrl?: string;
  /** Honest provenance label. */
  source: string;
}

export interface TtsDriverStatus {
  configured: boolean;
  healthy: boolean;
  detail: string;
}

export interface TtsDriver {
  readonly name: 'stub' | 'http';
  synthesize(input: TtsSynthesizeInput): Promise<TtsSpeech>;
  status(): Promise<TtsDriverStatus>;
}

/** Minimal SSML escaping. */
export function escapeSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Stub driver: wraps the text in a <speak> document so the IVR telephony
 * provider can read it aloud. Clearly labelled — no audio synthesis happens
 * on this deployment.
 */
export class StubTtsDriver implements TtsDriver {
  readonly name = 'stub' as const;

  synthesize(input: TtsSynthesizeInput): Promise<TtsSpeech> {
    return Promise.resolve({
      ssml: `<speak xml:lang="${escapeSsml(input.locale)}">${escapeSsml(input.text)}</speak>`,
      source: 'stub-ssml (text returned for the IVR provider to speak — no audio synthesized)'
    });
  }

  status(): Promise<TtsDriverStatus> {
    return Promise.resolve({
      configured: true,
      healthy: true,
      detail:
        'Stub driver: SSML text pass-through for the IVR provider. ' +
        'Set TTS_DRIVER=http and TTS_PROVIDER_URL to enable a live speech-synthesis provider.'
    });
  }
}

/** Expected response shape of the live provider's POST /synthesize. */
interface TtsSynthesizeResponse {
  ssml?: string;
  audio_url?: string;
}

/** Live TTS driver (fetch only) with the standard circuit breaker. */
export class HttpTtsDriver implements TtsDriver {
  readonly name = 'http' as const;

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string
  ) {}

  async synthesize(input: TtsSynthesizeInput): Promise<TtsSpeech> {
    this.assertCircuitClosed();
    try {
      const response = await httpJson<TtsSynthesizeResponse>(
        'tts',
        `${this.baseUrl}/synthesize`,
        {
          body: { text: input.text, locale: input.locale },
          headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined,
          timeoutMs: TTS_TIMEOUT_MS
        }
      );
      this.recordSuccess();
      return {
        ssml: response.ssml ?? `<speak xml:lang="${escapeSsml(input.locale)}">${escapeSsml(input.text)}</speak>`,
        ...(response.audio_url ? { audioUrl: response.audio_url } : {}),
        source: 'live-tts (external speech-synthesis provider)'
      };
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  async status(): Promise<TtsDriverStatus> {
    try {
      await httpJson('tts', `${this.baseUrl}/healthz`, { method: 'GET', timeoutMs: 2_500 });
      return { configured: true, healthy: true, detail: `TTS provider reachable at ${this.baseUrl}.` };
    } catch {
      return {
        configured: true,
        healthy: false,
        detail: `TTS provider unreachable at ${this.baseUrl} — synthesis will answer 503.`
      };
    }
  }

  /** Visible for tests: whether the circuit breaker is currently open. */
  get circuitOpen(): boolean {
    return this.consecutiveFailures >= TTS_CIRCUIT_THRESHOLD && Date.now() < this.circuitOpenUntil;
  }

  private assertCircuitClosed(): void {
    if (this.circuitOpen) {
      throw new ProviderRequestError(
        'tts',
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
    if (this.consecutiveFailures >= TTS_CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + TTS_CIRCUIT_COOLDOWN_MS;
    }
  }
}

export { ProviderConfigError, ProviderHttpError, ProviderRequestError };

/**
 * Builds the configured driver. Default is the stub; TTS_DRIVER=http
 * requires TTS_PROVIDER_URL and fails closed with ProviderConfigError
 * otherwise. TTS_API_KEY is an optional bearer credential.
 */
export function createTtsDriver(env: NodeJS.ProcessEnv = process.env): TtsDriver {
  const flag = (env.TTS_DRIVER ?? 'stub').toLowerCase();
  if (flag === 'http') {
    const baseUrl = requireEnv('tts', env, ['TTS_PROVIDER_URL']).replace(/\/+$/, '');
    return new HttpTtsDriver(baseUrl, env.TTS_API_KEY);
  }
  return new StubTtsDriver();
}
