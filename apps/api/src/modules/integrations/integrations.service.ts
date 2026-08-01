import { Injectable, NotFoundException } from '@nestjs/common';
import type { IntegrationStatus, NotificationChannel } from '@agric-platform/shared';
import {
  ADAPTER_DEFINITIONS,
  createAdapter,
  stubDelivery,
  stubWeatherSnapshot,
  type DeliveryResult,
  type IntegrationAdapter,
  type WeatherSnapshot
} from './adapters.js';

/**
 * Provider registry (SPEC contract 4): adapter interfaces with local stub
 * implementations and documented production drivers. Secrets come from the
 * environment only; nothing is committed to source control.
 */
@Injectable()
export class IntegrationsService {
  private readonly adapters = new Map<string, IntegrationAdapter>();

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
    const provider = channel === 'sms' ? 'termii' : channel === 'whatsapp' ? 'whatsapp' : 'local';
    const adapter = this.adapters.get(provider);
    return stubDelivery(provider, adapter?.driver ?? 'stub', channel);
  }

  weatherSnapshot(state: string): WeatherSnapshot {
    const adapter = this.get('weather');
    return stubWeatherSnapshot(state, `${adapter.provider} ${adapter.driver} driver`);
  }

  recordWebhook(provider: string, payload: unknown): { received: true; provider: string } {
    this.get(provider); // validates the provider exists
    return { received: true, provider };
  }
}
