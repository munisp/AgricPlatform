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
  readonly productionDriver: string;
  readonly driver: IntegrationDriver;
  readonly configured: boolean;
  readonly notes: string;
  status(): IntegrationStatus;
}

interface AdapterDefinition {
  provider: string;
  capability: string;
  envPrefix: string;
  productionDriver: string;
  stubNotes: string;
}

export const ADAPTER_DEFINITIONS: AdapterDefinition[] = [
  {
    provider: 'termii',
    capability: 'sms',
    envPrefix: 'TERMII',
    productionDriver: 'Termii REST API (messaging + OTP)',
    stubNotes: 'SMS deliveries are logged locally; no messages leave the process.'
  },
  {
    provider: 'whatsapp',
    capability: 'messaging',
    envPrefix: 'WHATSAPP',
    productionDriver: 'WhatsApp Business API via 360dialog',
    stubNotes: 'WhatsApp template sends are simulated.'
  },
  {
    provider: 'paystack',
    capability: 'payments',
    envPrefix: 'PAYSTACK',
    productionDriver: 'Paystack payments/escrow-ready charges',
    stubNotes: 'Payment intents are simulated; marketplace orders stay escrow-ready.'
  },
  {
    provider: 'moodle',
    capability: 'learning',
    envPrefix: 'MOODLE',
    productionDriver: 'Moodle web services (course sync)',
    stubNotes: 'Course catalogue is served from local seed data.'
  },
  {
    provider: 'discourse',
    capability: 'community',
    envPrefix: 'DISCOURSE',
    productionDriver: 'Discourse API (forum bridge)',
    stubNotes: 'Forum topics are stored locally.'
  },
  {
    provider: 'directus',
    capability: 'cms',
    envPrefix: 'DIRECTUS',
    productionDriver: 'Directus headless CMS (advisory content)',
    stubNotes: 'Advisory content is stored locally.'
  },
  {
    provider: 'weather',
    capability: 'weather_feed',
    envPrefix: 'WEATHER',
    productionDriver: 'NiMet / Open-Meteo / FEWS NET feeds',
    stubNotes: 'Weather snapshots are deterministic local fixtures.'
  },
  {
    provider: 'search',
    capability: 'search_index',
    envPrefix: 'SEARCH',
    productionDriver: 'Meilisearch (cross-domain index)',
    stubNotes: 'Search runs in memory across domain repositories.'
  }
];

function resolveDriver(envPrefix: string): { driver: IntegrationDriver; configured: boolean } {
  const explicit = process.env[`${envPrefix}_DRIVER`];
  const hasKey = Boolean(process.env[`${envPrefix}_API_KEY`] ?? process.env[`${envPrefix}_SECRET_KEY`]);
  if (explicit === 'production' || explicit === 'sandbox' || explicit === 'stub') {
    return { driver: explicit, configured: explicit === 'stub' ? false : hasKey };
  }
  return hasKey ? { driver: 'sandbox', configured: true } : { driver: 'stub', configured: false };
}

export function createAdapter(definition: AdapterDefinition): IntegrationAdapter {
  const { driver, configured } = resolveDriver(definition.envPrefix);
  return {
    provider: definition.provider,
    capability: definition.capability,
    envPrefix: definition.envPrefix,
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
