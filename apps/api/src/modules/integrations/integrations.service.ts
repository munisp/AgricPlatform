import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { IntegrationStatus, NotificationChannel } from '@agric-platform/shared';
import { isProduction } from '../../common/auth/auth.config.js';
import {
  ADAPTER_DEFINITIONS,
  createAdapter,
  stubDelivery,
  stubWeatherSnapshot,
  type DeliveryResult,
  type IntegrationAdapter,
  type WeatherSnapshot
} from './adapters.js';

/** Channels mapped to their provider adapter. */
const CHANNEL_PROVIDERS: Partial<Record<NotificationChannel, string>> = {
  sms: 'termii',
  whatsapp: 'whatsapp',
  email: 'mailgun',
  push: 'onesignal'
};

/** Provider-specific signature headers in priority order. */
const SIGNATURE_HEADERS = ['x-webhook-signature', 'x-paystack-signature', 'x-flutterwave-signature'];

/** Bounded replay cache: recently seen webhook digests per provider. */
const REPLAY_CACHE_LIMIT = 1000;

export interface WebhookReceipt {
  received: true;
  provider: string;
  /** True when the exact signed payload was already processed (safe replay). */
  duplicate?: boolean;
}

/**
 * Provider registry (SPEC contract 4): adapter interfaces with local stub
 * implementations and documented production drivers. Secrets come from the
 * environment only; nothing is committed to source control.
 */
@Injectable()
export class IntegrationsService {
  private readonly adapters = new Map<string, IntegrationAdapter>();
  private readonly seenWebhooks = new Map<string, string[]>();

  constructor() {
    for (const definition of ADAPTER_DEFINITIONS) {
      this.adapters.set(definition.provider, createAdapter(definition));
    }
  }

  list(): IntegrationStatus[] {
    return [...this.adapters.values()].map((adapter) => adapter.status());
  }

  get(provider: string): IntegrationAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new NotFoundException(`Unknown integration provider '${provider}'`);
    }
    return adapter;
  }

  status(provider: string): IntegrationStatus {
    return this.get(provider).status();
  }

  health(provider: string): IntegrationStatus {
    return this.status(provider);
  }

  /** Route a notification channel to its provider adapter (stub-safe). */
  deliver(channel: NotificationChannel): DeliveryResult {
    const provider = CHANNEL_PROVIDERS[channel] ?? 'local';
    const adapter = this.adapters.get(provider);
    return stubDelivery(provider, adapter?.driver ?? 'stub', channel);
  }

  weatherSnapshot(state: string): WeatherSnapshot {
    const adapter = this.get('weather');
    return stubWeatherSnapshot(state, `${adapter.provider} ${adapter.driver} driver`);
  }

  /**
   * Webhook signature bypass is a development convenience only: it applies
   * when the provider runs the stub driver AND the process is not in
   * production. Every other case requires a valid HMAC signature.
   */
  webhookBypassAllowed(provider: string): boolean {
    return this.get(provider).driver === 'stub' && !isProduction();
  }

  /** Resolves the webhook signing secret for a provider, if configured. */
  webhookSecret(provider: string): string | undefined {
    const adapter = this.get(provider);
    return (
      process.env[`${adapter.envPrefix}_WEBHOOK_SECRET`] ?? process.env.WEBHOOK_SIGNING_SECRET
    );
  }

  /**
   * Verifies a provider webhook. `rawBody` must be the exact request body
   * bytes (preserved in bootstrap); the signature is an HMAC-SHA256 hex
   * digest (optionally `sha256=`-prefixed) of those bytes.
   */
  verifyWebhookSignature(
    provider: string,
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>
  ): string | undefined {
    if (this.webhookBypassAllowed(provider)) {
      return undefined;
    }
    const secret = this.webhookSecret(provider);
    if (!secret) {
      // Fail closed: a non-stub webhook endpoint without a secret is a
      // misconfiguration, not an open door.
      throw new Error(
        `Webhook signature verification for provider '${provider}' requires ` +
          `${this.get(provider).envPrefix}_WEBHOOK_SECRET or WEBHOOK_SIGNING_SECRET`
      );
    }
    const signatureHeader = SIGNATURE_HEADERS.map((name) => headers[name])
      .map((value) => (Array.isArray(value) ? value[0] : value))
      .find((value) => Boolean(value));
    if (!signatureHeader || !rawBody) {
      throw new UnauthorizedException(`Missing webhook signature for provider '${provider}'`);
    }
    const provided = signatureHeader.replace(/^sha256=/, '').trim();
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const providedBuffer = Buffer.from(provided, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (
      providedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException(`Invalid webhook signature for provider '${provider}'`);
    }
    return expected;
  }

  /**
   * Records a verified webhook. Replays of the exact signed payload are
   * idempotent: they return `duplicate: true` without re-triggering side
   * effects (callers still get a 200 so providers stop retrying).
   */
  recordWebhook(provider: string, payload: unknown, signatureDigest?: string): WebhookReceipt {
    this.get(provider); // validates the provider exists
    const digest =
      signatureDigest ?? createHmac('sha256', 'unsigned').update(stableStringify(payload)).digest('hex');
    const seen = this.seenWebhooks.get(provider) ?? [];
    if (seen.includes(digest)) {
      return { received: true, provider, duplicate: true };
    }
    seen.push(digest);
    if (seen.length > REPLAY_CACHE_LIMIT) {
      seen.shift();
    }
    this.seenWebhooks.set(provider, seen);
    return { received: true, provider };
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(',')}}`;
}
