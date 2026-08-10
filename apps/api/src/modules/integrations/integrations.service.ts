import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { IntegrationStatus, NotificationChannel } from '@agric-platform/shared';
import { isProduction } from '../../common/auth/auth.config.js';
import { KEY_VALUE_STORE, WEBHOOK_DEDUPE_STORE } from '../../database/persistence.tokens.js';
import {
  createInMemoryWebhookDedupeStore,
  type WebhookDedupeStore
} from '../../database/repositories/webhook-dedupe.repository.js';
import type { KeyValueStore } from '../../redis/key-value-store.js';
import {
  ADAPTER_DEFINITIONS,
  createAdapter,
  stubDelivery,
  stubWeatherSnapshot,
  type DeliveryResult,
  type IntegrationAdapter,
  type WeatherSnapshot
} from './adapters.js';
import {
  createDirectusClient,
  createDiscourseClient,
  createMoodleClient,
  type DirectusClient,
  type DiscourseClient,
  type MoodleClient
} from './drivers/bridge.clients.js';
import { createEmailDriver, type EmailDriver } from './drivers/email.drivers.js';
import {
  createPaymentDriver,
  type PaymentDriver
} from './drivers/payments.drivers.js';
import { createPushDriver, type OneSignalPushDriver } from './drivers/push.drivers.js';
import { createSearchProvider, type SearchProvider } from './drivers/search.drivers.js';
import { createSmsDriver, type SmsDriver } from './drivers/sms.drivers.js';
import { createWeatherProvider, type WeatherProvider } from './drivers/weather.drivers.js';
import {
  createWhatsAppDriver,
  type Dialog360WhatsAppDriver
} from './drivers/whatsapp.drivers.js';

/** Channels mapped to their provider adapter. */
const CHANNEL_PROVIDERS: Partial<Record<NotificationChannel, string>> = {
  sms: 'termii',
  whatsapp: 'whatsapp',
  email: 'mailgun',
  push: 'onesignal'
};

/**
 * Channels the synchronous notification pipeline (deliver → deliverMessage)
 * can honour with a live driver. A non-stub adapter on any other channel
 * would be silently unhonourable — the production boot guard below refuses
 * that configuration instead of fabricating delivery.
 */
const LIVE_DELIVERABLE_CHANNELS: ReadonlySet<string> = new Set(['sms', 'whatsapp', 'email', 'push']);

/** Provider-specific signature headers in priority order. */
const SIGNATURE_HEADERS = ['x-webhook-signature', 'x-paystack-signature', 'x-flutterwave-signature'];

export interface WebhookReceipt {
  received: true;
  provider: string;
  /** True when the exact signed payload was already processed (safe replay). */
  duplicate?: boolean;
}

/** Outbound message for the live delivery path (deliverMessage). */
export interface OutboundMessage {
  /** Phone number, email address or external user id depending on channel. */
  to: string;
  text: string;
  /** Email subject / push title / WhatsApp template name. */
  subject?: string;
  html?: string;
}

/** Live driver instances, keyed by provider name. */
type LiveDriver =
  | SmsDriver
  | Dialog360WhatsAppDriver
  | EmailDriver
  | OneSignalPushDriver
  | PaymentDriver
  | SearchProvider
  | WeatherProvider
  | MoodleClient
  | DiscourseClient
  | DirectusClient;

/**
 * Provider registry (SPEC contract 4): adapter interfaces with local stub
 * implementations and documented production drivers. Secrets come from the
 * environment only; nothing is committed to source control.
 */
@Injectable()
export class IntegrationsService {
  private readonly adapters = new Map<string, IntegrationAdapter>();
  private readonly fallbackDedupe = createInMemoryWebhookDedupeStore();
  private readonly liveDrivers = new Map<string, LiveDriver>();

  constructor(
    @Optional() @Inject(KEY_VALUE_STORE) private readonly kv?: KeyValueStore,
    // Durable webhook dedupe (funds-integrity wave): pg-backed in
    // production; the bounded in-memory cache remains the fallback when no
    // store is wired (bare service constructions in unit tests).
    @Optional() @Inject(WEBHOOK_DEDUPE_STORE) private readonly dedupe?: WebhookDedupeStore
  ) {
    for (const definition of ADAPTER_DEFINITIONS) {
      this.adapters.set(definition.provider, createAdapter(definition));
    }
    this.assertLiveDriversConfigured();
  }

  /**
   * Boot-time fail closed (wave P1): in production, every non-stub driver
   * is constructed eagerly so a missing credential aborts startup with a
   * ProviderConfigError instead of surfacing on the first outbound call.
   * Outside production, drivers build lazily so sandboxes can be partial.
   */
  private assertLiveDriversConfigured(): void {
    if (!isProduction()) {
      return;
    }
    for (const adapter of this.adapters.values()) {
      if (adapter.driver !== 'stub') {
        this.liveDriver(adapter.provider);
      }
    }
    // Fail closed when a notification channel's adapter is configured
    // non-stub but the deliver path has no live case for it — never boot a
    // production process whose notification pipeline cannot honour the
    // configured driver.
    for (const [channel, provider] of Object.entries(CHANNEL_PROVIDERS)) {
      const adapter = this.adapters.get(provider);
      if (adapter && adapter.driver !== 'stub' && !LIVE_DELIVERABLE_CHANNELS.has(channel)) {
        throw new Error(
          `FATAL: notification channel '${channel}' (provider '${provider}') is configured ` +
            `${adapter.driver} but the delivery pipeline has no live driver for it. ` +
            'Set the driver flag back to stub or wire the live driver. Refusing to start.'
        );
      }
    }
  }

  /** Builds (and caches) the live driver for a provider; undefined on stub. */
  private liveDriver(provider: string): LiveDriver | undefined {
    const adapter = this.get(provider);
    if (adapter.driver === 'stub') {
      return undefined;
    }
    const cached = this.liveDrivers.get(provider);
    if (cached) {
      return cached;
    }
    const env = process.env;
    let driver: LiveDriver;
    switch (provider) {
      case 'termii':
        driver = createSmsDriver(env, adapter.driver);
        break;
      case 'whatsapp':
        driver = createWhatsAppDriver(env, adapter.driver);
        break;
      case 'mailgun':
        driver = createEmailDriver(env, adapter.driver);
        break;
      case 'onesignal':
        driver = createPushDriver(env, adapter.driver);
        break;
      case 'paystack':
      case 'flutterwave':
        driver = createPaymentDriver(provider, env);
        break;
      case 'search':
        driver = createSearchProvider(env);
        break;
      case 'weather':
        // Open-Meteo needs no credentials; the 15-minute cache rides the
        // shared KeyValueStore (Redis when REDIS_URL is configured).
        driver = createWeatherProvider(this.kv);
        break;
      case 'moodle':
        driver = createMoodleClient(env);
        break;
      case 'discourse':
        driver = createDiscourseClient(env);
        break;
      case 'directus':
        driver = createDirectusClient(env);
        break;
      default:
        return undefined;
    }
    this.liveDrivers.set(provider, driver);
    return driver;
  }

  /** Live SMS driver (Termii + Twilio failover); undefined while stub. */
  smsDriver(): SmsDriver | undefined {
    return this.liveDriver('termii') as SmsDriver | undefined;
  }

  /** Live WhatsApp driver (360dialog); undefined while stub. */
  whatsappDriver(): Dialog360WhatsAppDriver | undefined {
    return this.liveDriver('whatsapp') as Dialog360WhatsAppDriver | undefined;
  }

  /** Live email driver (Mailgun or SendGrid); undefined while stub. */
  emailDriver(): EmailDriver | undefined {
    return this.liveDriver('mailgun') as EmailDriver | undefined;
  }

  /** Live push driver (OneSignal); undefined while stub. */
  pushDriver(): OneSignalPushDriver | undefined {
    return this.liveDriver('onesignal') as OneSignalPushDriver | undefined;
  }

  /** Live payment driver for paystack/flutterwave; undefined while stub. */
  paymentDriver(provider: 'paystack' | 'flutterwave'): PaymentDriver | undefined {
    return this.liveDriver(provider) as PaymentDriver | undefined;
  }

  /** Live search provider (Meilisearch); undefined while stub. */
  searchProvider(): SearchProvider | undefined {
    return this.liveDriver('search') as SearchProvider | undefined;
  }

  /** Live weather provider (Open-Meteo, cached); undefined while stub. */
  weatherProvider(): WeatherProvider | undefined {
    return this.liveDriver('weather') as WeatherProvider | undefined;
  }

  /** Fail-closed bridge clients for the self-hosted Phase 1 systems. */
  moodleClient(): MoodleClient | undefined {
    return this.liveDriver('moodle') as MoodleClient | undefined;
  }

  discourseClient(): DiscourseClient | undefined {
    return this.liveDriver('discourse') as DiscourseClient | undefined;
  }

  directusClient(): DirectusClient | undefined {
    return this.liveDriver('directus') as DirectusClient | undefined;
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

  /**
   * Route a notification channel to its provider adapter. This is the SAME
   * live-driver switch as deliverMessage: a non-stub adapter invokes the
   * real provider driver, and the stub driver returns an honest
   * delivered:false result (never fabricated 'sent'). Channels without an
   * external provider (in_app) stay on the local stub.
   */
  async deliver(channel: NotificationChannel, message: OutboundMessage): Promise<DeliveryResult> {
    return this.deliverMessage(channel, message);
  }

  /**
   * Live delivery path (wave P1): routes the message through the real
   * provider driver when the channel's adapter is non-stub, and returns an
   * honest stub result otherwise (delivered:false — nothing was sent; the
   * retry machinery keeps the message pending). Drivers throw
   * ProviderConfigError/ProviderHttpError/ProviderRequestError — callers
   * own retry policy.
   */
  async deliverMessage(
    channel: NotificationChannel,
    message: OutboundMessage
  ): Promise<DeliveryResult> {
    const provider = CHANNEL_PROVIDERS[channel] ?? 'local';
    const adapter = this.adapters.get(provider);
    if (provider === 'local') {
      // In-app channel: the persisted notification record IS the delivery
      // (no external provider exists), so delivered:true is honest here.
      return {
        delivered: true,
        provider,
        driver: 'stub',
        providerRef: `local-inbox-${Date.now()}`,
        note: 'In-app inbox delivery (notification record persisted locally)'
      };
    }
    if (!adapter || adapter.driver === 'stub') {
      return stubDelivery(provider, adapter?.driver ?? 'stub', channel);
    }
    switch (channel) {
      case 'sms':
        return this.requiredDriver(this.smsDriver(), provider).sendSms({
          to: message.to,
          message: message.text
        });
      case 'whatsapp':
        return this.requiredDriver(this.whatsappDriver(), provider).sendText({
          to: message.to,
          message: message.text
        });
      case 'email':
        return this.requiredDriver(this.emailDriver(), provider).send({
          to: message.to,
          subject: message.subject ?? 'AgricPlatform notification',
          text: message.text,
          html: message.html
        });
      case 'push':
        return this.requiredDriver(this.pushDriver(), provider).send({
          userIds: [message.to],
          title: message.subject ?? 'AgricPlatform',
          body: message.text
        });
      default:
        return stubDelivery(provider, adapter.driver, channel);
    }
  }

  /** Fail closed when a non-stub adapter has no live driver (should not happen). */
  private requiredDriver<T>(driver: T | undefined, provider: string): T {
    if (!driver) {
      throw new Error(`Live driver for provider '${provider}' is unavailable`);
    }
    return driver;
  }

  /**
   * Weather readiness snapshot for the advisory path (wave P1). A non-stub
   * WEATHER_DRIVER resolves to the Open-Meteo live feed (no credentials
   * required) with a 15-minute cache on the shared KeyValueStore. The stub
   * fixture is NON-PRODUCTION ONLY and clearly labelled as a fixture —
   * production fails CLOSED with 503 instead of serving fabricated weather
   * (mirrors the commodity-price provider pattern).
   */
  async weatherSnapshot(state: string): Promise<WeatherSnapshot> {
    const adapter = this.get('weather');
    const provider = adapter.driver === 'stub' ? undefined : this.weatherProvider();
    if (!provider) {
      if (isProduction()) {
        throw new ServiceUnavailableException(
          'Weather feed is not configured. Set WEATHER_DRIVER=sandbox|production to enable the ' +
            'live Open-Meteo feed (see docs/integration-matrix.md). Refusing to serve the ' +
            'deterministic fixture in production.'
        );
      }
      return stubWeatherSnapshot(
        state,
        `FIXTURE ${adapter.provider} ${adapter.driver} driver (non-production only, not live data)`
      );
    }
    return provider.snapshot(state);
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
   * effects (callers still get a 200 so providers stop retrying). Dedupe is
   * durable when the WEBHOOK_DEDUPE_STORE is pg-backed — replays are
   * suppressed across restarts and instances via
   * integrations.inbound_events UNIQUE (system, dedupe_key).
   */
  async recordWebhook(
    provider: string,
    payload: unknown,
    signatureDigest?: string
  ): Promise<WebhookReceipt> {
    this.get(provider); // validates the provider exists
    const digest =
      signatureDigest ?? createHmac('sha256', 'unsigned').update(stableStringify(payload)).digest('hex');
    const store = this.dedupe ?? this.fallbackDedupe;
    const isNew = await store.recordIfNew(provider, digest, payload);
    return isNew ? { received: true, provider } : { received: true, provider, duplicate: true };
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
