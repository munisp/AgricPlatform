import type { IntegrationStatus, NotificationChannel } from '@agric-platform/shared';

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
    productionDriver: 'NiMet / Open-Meteo / FEWS NET feeds',
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
    return { driver: explicit, configured: hasKey };
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
  if (env.NODE_ENV !== 'production') {
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

/** Stub message delivery used when no sandbox/production driver is configured. */
export function stubDelivery(provider: string, driver: IntegrationDriver, channel: NotificationChannel): DeliveryResult {
  return {
    delivered: true,
    provider,
    driver,
    providerRef: `${provider}-stub-${Date.now()}`,
    note: `Delivered via ${driver} ${channel} driver (no external network call)`
  };
}
