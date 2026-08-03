/**
 * SpeechProvider port — ASR (speech-to-text) for the voice agronomist
 * (wave VOICE). The STUB driver is the default: it accepts the caller's
 * text directly (clearly labelled — no real audio decoding), keeping CI and
 * local dev deterministic. ASR_DRIVER=http selects the live provider behind
 * ASR_PROVIDER_URL (+ optional ASR_API_KEY bearer); the factory fails
 * closed with ProviderConfigError when http is selected without a URL, and
 * the live driver answers with ProviderRequestError (mapped to 503 by the
 * service) when the provider is unreachable — it NEVER silently degrades to
 * the stub, because that would fabricate a transcript. Mirrors the
 * geo-intel flood-risk driver doctrine, including the call-time circuit
 * breaker.
 */
import {
  httpJson,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  requireEnv
} from '../integrations/drivers/http.js';

/** Consecutive provider failures before the circuit opens. */
export const ASR_CIRCUIT_THRESHOLD = 3;
/** How long the circuit stays open before the next call is allowed through. */
export const ASR_CIRCUIT_COOLDOWN_MS = 30_000;
/** Live transcription timeout (mirrors the shared 5s provider default). */
export const ASR_TIMEOUT_MS = 5_000;

export interface SpeechTranscribeInput {
  /** Pre-transcribed text (USSD/typed channels, and the stub's pass-through). */
  text?: string;
  /** Audio object URL supplied by the telephony provider (live ASR only). */
  audioUrl?: string;
  locale: string;
}

export interface SpeechTranscription {
  text: string;
  /** 0-1 transcription confidence (stub fixtures are labelled low). */
  confidence: number;
  /** Honest provenance label — never presented as a verified transcript. */
  source: string;
}

export interface SpeechProviderStatus {
  configured: boolean;
  healthy: boolean;
  detail: string;
}

export interface SpeechProvider {
  readonly name: 'stub' | 'http';
  transcribe(input: SpeechTranscribeInput): Promise<SpeechTranscription>;
  status(): Promise<SpeechProviderStatus>;
}

/**
 * Deterministic stub: passes the supplied text through untouched (labelled),
 * or — when only audio is given — returns a clearly-labelled SIMULATED
 * transcript at low confidence so flows naturally route to a human instead
 * of trusting fabricated text.
 */
export class StubSpeechProvider implements SpeechProvider {
  readonly name = 'stub' as const;

  transcribe(input: SpeechTranscribeInput): Promise<SpeechTranscription> {
    if (input.text && input.text.trim().length > 0) {
      return Promise.resolve({
        text: input.text.trim(),
        confidence: 1,
        source: 'stub-text-passthrough (typed/DTMF input — no ASR decoding performed)'
      });
    }
    if (input.audioUrl) {
      return Promise.resolve({
        text: `simulated transcript for ${input.audioUrl}`,
        confidence: 0.2,
        source:
          'stub-fixture (SIMULATED transcript — the stub ASR cannot decode audio; low confidence by design)'
      });
    }
    return Promise.resolve({
      text: '',
      confidence: 0,
      source: 'stub-text-passthrough (empty input)'
    });
  }

  status(): Promise<SpeechProviderStatus> {
    return Promise.resolve({
      configured: true,
      healthy: true,
      detail:
        'Stub driver: text pass-through, simulated transcripts for audio. ' +
        'Set ASR_DRIVER=http and ASR_PROVIDER_URL to enable a live speech-to-text provider.'
    });
  }
}

/** Expected response shape of the live provider's POST /transcribe. */
interface AsrTranscribeResponse {
  text?: string;
  confidence?: number;
}

/**
 * Live ASR driver (fetch only — no new dependencies). 5s timeout, bearer
 * auth when ASR_API_KEY is set, call-time circuit breaker after
 * ASR_CIRCUIT_THRESHOLD consecutive failures.
 */
export class HttpSpeechProvider implements SpeechProvider {
  readonly name = 'http' as const;

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string
  ) {}

  async transcribe(input: SpeechTranscribeInput): Promise<SpeechTranscription> {
    this.assertCircuitClosed();
    try {
      const response = await httpJson<AsrTranscribeResponse>(
        'asr',
        `${this.baseUrl}/transcribe`,
        {
          body: {
            audio_url: input.audioUrl,
            text: input.text,
            locale: input.locale
          },
          headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined,
          timeoutMs: ASR_TIMEOUT_MS
        }
      );
      this.recordSuccess();
      return {
        text: response.text ?? '',
        confidence: response.confidence ?? 0,
        source: 'live-asr (external speech-to-text provider — accuracy unverified)'
      };
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  async status(): Promise<SpeechProviderStatus> {
    try {
      await httpJson('asr', `${this.baseUrl}/healthz`, { method: 'GET', timeoutMs: 2_500 });
      return { configured: true, healthy: true, detail: `ASR provider reachable at ${this.baseUrl}.` };
    } catch {
      return {
        configured: true,
        healthy: false,
        detail: `ASR provider unreachable at ${this.baseUrl} — transcription will answer 503.`
      };
    }
  }

  /** Visible for tests: whether the circuit breaker is currently open. */
  get circuitOpen(): boolean {
    return this.consecutiveFailures >= ASR_CIRCUIT_THRESHOLD && Date.now() < this.circuitOpenUntil;
  }

  private assertCircuitClosed(): void {
    if (this.circuitOpen) {
      throw new ProviderRequestError(
        'asr',
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
    if (this.consecutiveFailures >= ASR_CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + ASR_CIRCUIT_COOLDOWN_MS;
    }
  }
}

export { ProviderConfigError, ProviderHttpError, ProviderRequestError };

/**
 * Builds the configured provider. Default is the stub; ASR_DRIVER=http
 * requires ASR_PROVIDER_URL and fails closed with ProviderConfigError
 * otherwise. ASR_API_KEY is an optional bearer credential.
 */
export function createSpeechProvider(env: NodeJS.ProcessEnv = process.env): SpeechProvider {
  const flag = (env.ASR_DRIVER ?? 'stub').toLowerCase();
  if (flag === 'http') {
    const baseUrl = requireEnv('asr', env, ['ASR_PROVIDER_URL']).replace(/\/+$/, '');
    return new HttpSpeechProvider(baseUrl, env.ASR_API_KEY);
  }
  return new StubSpeechProvider();
}
