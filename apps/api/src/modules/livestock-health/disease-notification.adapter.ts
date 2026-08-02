import { Injectable, Logger } from '@nestjs/common';
import type { DiseaseFlag } from '@agric-platform/shared';
import { resolveDiseaseNotificationUrl } from '../../config/livestock-health.config.js';

export interface DiseaseNotificationResult {
  delivered: boolean;
  /** Why delivery did not happen (e.g. 'not_configured'). */
  reason?: string;
}

/**
 * Outbound port for pushing confirmed disease flags to the government
 * (state veterinary authority / FMD&S) notification endpoint.
 */
export interface DiseaseNotificationPort {
  notifyConfirmed(flag: DiseaseFlag): Promise<DiseaseNotificationResult>;
}

/**
 * Government disease-notification adapter (blueprint F5.1). FAILS CLOSED:
 * without DISEASE_NOTIFICATION_URL configured it reports not_configured and
 * delivers nothing — there is intentionally no simulated success path, and
 * no credentials are fabricated. The HTTP transport lands with the first
 * real integration; until then the stub keeps the failure explicit so
 * dashboards can surface the gap instead of a silent fake.
 */
@Injectable()
export class GovernmentDiseaseNotificationAdapter implements DiseaseNotificationPort {
  private readonly logger = new Logger(GovernmentDiseaseNotificationAdapter.name);
  private readonly endpointUrl = resolveDiseaseNotificationUrl();

  async notifyConfirmed(flag: DiseaseFlag): Promise<DiseaseNotificationResult> {
    if (!this.endpointUrl) {
      this.logger.warn(
        `disease flag '${flag.id}' confirmed but DISEASE_NOTIFICATION_URL is not configured; notification not delivered`
      );
      return { delivered: false, reason: 'not_configured' };
    }
    // No transport is implemented yet — fail closed rather than simulate.
    this.logger.warn(
      `disease notification transport to ${this.endpointUrl} is not implemented; flag '${flag.id}' not delivered`
    );
    return { delivered: false, reason: 'transport_unimplemented' };
  }
}
