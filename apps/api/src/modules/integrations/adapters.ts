import type { IntegrationStatus, NotificationChannel } from '@agric-platform/shared';
import { isProduction } from '../../common/auth/auth.config.js';

export type IntegrationDriver = IntegrationStatus['driver'];

export interface DeliveryResult {
  delivered: boolean;
  provider: string;
  driver: IntegrationDriver;
  providerRef: string;
  note: string;
}

export interface WeatherSnapshot {
  state: string;
  temperatureCelsius: number;
  humidityPercent: number;
  rainfallMm: number;
  outlook: string;
  source: string;
}

/**
 * Provider adapter port. Every external system (SPEC contract 4/6) is an
 * adapter with a local stub driver and documented production credentials.
 * No adapter performs network I/O unless a sandbox/production driver is
 * explicitly configured with credentials via environment variables.
 */
export interface IntegrationAdapter {
  readonly provider: string;
  readonly capability: string;
  readonly envPrefix: string;
  readonly driverEnv: string;
  readonly productionDriver: string;
  readonly driver: IntegrationDriver;
  readonly configured: boolean;
  readonly notes: string;
  status(): IntegrationStatus;
}

interface AdapterDefinition {
  provider: string;
  capability: string;
  /** Prefix for credential variables, e.g. TERMII_API_KEY. */
  envPrefix: string;
  /**
   * Canonical driver flag from docs/integration-matrix.md, e.g. SMS_DRIVER.
   * The legacy `<PREFIX>_DRIVER> variable is honoured as a fallback.
   */
  driverEnv: string;
  /** Additional credential variables that count as configured. */
  credentialEnvs?: string[];
  /**
   * True when the production driver is a keyless/open API (Open-Meteo
   * weather): the non-stub driver needs no credentials, so the production
   * boot assertion treats it as configured.
   */
  credentialsOptional?: boolean;
  productionDriver: string;
  stubNotes: string;
}

export const ADAPTER_DEFINITIONS: AdapterDefinition[] = [
  {
    provider: 'termii',
    capability: 'sms',
    envPrefix: 'TERMII',
    driverEnv: 'SMS_DRIVER',
    credentialEnvs: ['TWILIO_ACCOUNT_SID'],
    productionDriver: 'Termii REST API (messaging + OTP)',
    stubNotes: 'SMS deliveries are logged locally; no messages leave the process.'
  },
  {
    provider: 'whatsapp',
    capability: 'messaging',
    envPrefix: 'WHATSAPP',
    driverEnv: 'WHATSAPP_DRIVER',
    credentialEnvs: ['WHATSAPP_360DIALOG_API_KEY'],
    productionDriver: 'WhatsApp Business API via 360dialog',
    stubNotes: 'WhatsApp template sends are simulated.'
  },
  {
    provider: 'mailgun',
    capability: 'email',
    envPrefix: 'MAILGUN',
    driverEnv: 'EMAIL_DRIVER',
    credentialEnvs: ['SENDGRID_API_KEY'],
    productionDriver: 'Mailgun (or SendGrid) transactional email',
    stubNotes: 'Email templates render to the local outbox; nothing is sent.'
  },
  {
    provider: 'onesignal',
    capability: 'push',
    envPrefix: 'ONESIGNAL',
    driverEnv: 'PUSH_DRIVER',
    credentialEnvs: ['ONESIGNAL_REST_API_KEY'],
    productionDriver: 'OneSignal web/mobile push',
    stubNotes: 'Push payloads are recorded locally; no device registration occurs.'
  },
  {
    provider: 'paystack',
    capability: 'payments',
    envPrefix: 'PAYSTACK',
    driverEnv: 'PAYMENT_DRIVER',
    productionDriver: 'Paystack payments/escrow-ready charges',
    stubNotes: 'Payment intents are simulated; marketplace orders stay escrow-ready.'
  },
  {
    provider: 'flutterwave',
    capability: 'payments',
    envPrefix: 'FLUTTERWAVE',
    driverEnv: 'PAYMENT_DRIVER',
    productionDriver: 'Flutterwave collections/disbursements (fallback PSSP)',
    stubNotes: 'Flutterwave is the fallback rail; stub records intents locally.'
  },
  {
    provider: 'moodle',
    capability: 'learning',
    envPrefix: 'MOODLE',
    driverEnv: 'LMS_DRIVER',
    credentialEnvs: ['MOODLE_TOKEN'],
    productionDriver: 'Moodle web services (course sync)',
    stubNotes: 'Course catalogue is served from local seed data.'
  },
  {
    provider: 'discourse',
    capability: 'community',
    envPrefix: 'DISCOURSE',
    driverEnv: 'COMMUNITY_DRIVER',
    productionDriver: 'Discourse API (forum bridge)',
    stubNotes: 'Forum topics are stored locally.'
  },
  {
    provider: 'directus',
    capability: 'cms',
    envPrefix: 'DIRECTUS',
    driverEnv: 'CMS_DRIVER',
    credentialEnvs: ['DIRECTUS_TOKEN'],
    productionDriver: 'Directus headless CMS (advisory content)',
    stubNotes: 'Advisory content is stored locally.'
  },
  {
    provider: 'weather',
    capability: 'weather_feed',
    envPrefix: 'WEATHER',
    driverEnv: 'WEATHER_DRIVER',
    // Open-Meteo is the real default feed and needs no credentials.
    credentialsOptional: true,
    productionDriver: 'Open-Meteo (keyless) / NiMet (MoU-gated) feeds',
    stubNotes: 'Weather snapshots are deterministic local fixtures.'
  },
  {
    provider: 'search',
    capability: 'search_index',
    envPrefix: 'SEARCH',
    driverEnv: 'SEARCH_DRIVER',
    credentialEnvs: ['MEILISEARCH_API_KEY'],
    productionDriver: 'Meilisearch (cross-domain index)',
    stubNotes: 'Search runs in memory across domain repositories.'
  }
];

function credentialEnvNames(definition: AdapterDefinition): string[] {
  return [
    `${definition.envPrefix}_API_KEY`,
    `${definition.envPrefix}_SECRET_KEY`,
    ...(definition.credentialEnvs ?? [])
  ];
}

export function resolveDriver(
  definition: AdapterDefinition,
  env: NodeJS.ProcessEnv = process.env
): { driver: IntegrationDriver; configured: boolean } {
  const explicit = env[definition.driverEnv] ?? env[`${definition.envPrefix}_DRIVER`];
  const hasKey = credentialEnvNames(definition).some((name) => Boolean(env[name]));
  if (explicit === 'production' || explicit === 'sandbox' || explicit === 'stub') {
    // Keyless production drivers (Open-Meteo weather) count as configured
    // only when the operator explicitly opts into the live driver — the
    // stub default must stay credential-driven.
    return { driver: explicit, configured: hasKey || definition.credentialsOptional === true };
  }
  return hasKey ? { driver: 'sandbox', configured: true } : { driver: 'stub', configured: false };
}

export function createAdapter(
  definition: AdapterDefinition,
  env: NodeJS.ProcessEnv = process.env
): IntegrationAdapter {
  const { driver, configured } = resolveDriver(definition, env);
  return {
    provider: definition.provider,
    capability: definition.capability,
    envPrefix: definition.envPrefix,
    driverEnv: definition.driverEnv,
    productionDriver: definition.productionDriver,
    driver,
    configured,
    notes:
      driver === 'stub'
        ? `${definition.stubNotes} Production driver: ${definition.productionDriver}.`
        : `Running against ${definition.productionDriver} in ${driver} mode.`,
    status(): IntegrationStatus {
      return {
        provider: this.provider,
        capability: this.capability,
        driver: this.driver,
        configured: this.configured,
        healthy: this.driver === 'stub' ? true : this.configured,
        notes: this.notes
      };
    }
  };
}

/**
 * Fail loudly in production when a non-stub driver lacks credentials
 * (docs/security-compliance.md §6). Stub drivers stay allowed so individual
 * integrations can be rolled out incrementally.
 */
export function assertProductionDriverConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProduction(env)) {
    return;
  }
  const broken = ADAPTER_DEFINITIONS.filter((definition) => {
    const { driver, configured } = resolveDriver(definition, env);
    return driver !== 'stub' && !configured;
  }).map(
    (definition) =>
      `${definition.provider} (${definition.driverEnv}=${env[definition.driverEnv] ?? env[`${definition.envPrefix}_DRIVER`]}; ` +
      `expected one of: ${credentialEnvNames(definition).join(', ')})`
  );
  if (broken.length > 0) {
    throw new Error(
      `FATAL: integration drivers are enabled without credentials: ${broken.join('; ')}. ` +
        'Provide the credentials or set the driver flag back to stub. Refusing to start.'
    );
  }
}

/**
 * Published development-only webhook signing fallback. It is committed in
 * .env.example and historically shipped in infra/docker-compose.yml, so it
 * must NEVER authenticate a production webhook.
 */
export const WEBHOOK_DEV_ONLY_SECRET = 'local-development-only';

/** Minimum acceptable length for a production webhook signing secret. */
export const WEBHOOK_SECRET_MIN_LENGTH = 16;

/**
 * Fail-closed boot check (mirrors resolveVoucherSecret): webhook HMAC
 * secrets authenticate provider callbacks that move money and state. A
 * secret equal to the published development default — or too short to
 * resist guessing — would let anyone forge signed webhooks. Refuse to
 * start instead. Resolution mirrors IntegrationsService.webhookSecret:
 * `<PREFIX>_WEBHOOK_SECRET` wins over the shared WEBHOOK_SIGNING_SECRET.
 * An unset secret stays legal here because the per-request verifier already
 * fails closed without one; this assertion targets KNOWN-WEAK secrets.
 */
export function assertProductionWebhookSecrets(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProduction(env)) {
    return;
  }
  const isWeak = (secret: string | undefined): secret is string =>
    secret !== undefined &&
    (secret === WEBHOOK_DEV_ONLY_SECRET || secret.trim().length < WEBHOOK_SECRET_MIN_LENGTH);
  const weak: string[] = [];
  if (isWeak(env.WEBHOOK_SIGNING_SECRET)) {
    weak.push('WEBHOOK_SIGNING_SECRET');
  }
  for (const definition of ADAPTER_DEFINITIONS) {
    const name = `${definition.envPrefix}_WEBHOOK_SECRET`;
    if (isWeak(env[name])) {
      weak.push(name);
    }
  }
  if (weak.length > 0) {
    throw new Error(
      `FATAL: weak webhook signing secret(s) in production: ${weak.join(', ')}. ` +
        `The published development default ('${WEBHOOK_DEV_ONLY_SECRET}') and secrets shorter ` +
        `than ${WEBHOOK_SECRET_MIN_LENGTH} characters are forbidden. Provision a high-entropy ` +
        'secret via the deployment secret store. Refusing to start.'
    );
  }
}

/** Deterministic local weather fixture (no network). */
export function stubWeatherSnapshot(state: string, source: string): WeatherSnapshot {
  const seed = [...state].reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return {
    state,
    temperatureCelsius: 24 + (seed % 10),
    humidityPercent: 40 + (seed % 45),
    rainfallMm: seed % 25,
    outlook: seed % 2 === 0 ? 'Light showers expected within 48 hours' : 'Dry spell likely this week',
    source
  };
}

/**
 * Stub message delivery used when no sandbox/production driver is configured.
 * Honest by construction: a stub NEVER reports delivered — nothing left the
 * process, so callers keep the message pending and route it through the
 * retry machinery instead of falsely marking it 'sent'.
 */
export function stubDelivery(provider: string, driver: IntegrationDriver, channel: NotificationChannel): DeliveryResult {
  return {
    delivered: false,
    provider,
    driver,
    providerRef: `${provider}-stub-${Date.now()}`,
    note: `Simulated ${channel} delivery via ${driver} driver (no external network call; message NOT sent)`
  };
}
