import { ServiceUnavailableException } from '@nestjs/common';
import type { InsurancePolicy } from '@agric-platform/shared';

/**
 * External provider adapter ports for wave L1c (insurance + cold chain).
 * Mirroring the integrations module, the shipped stubs FAIL CLOSED: without
 * configuration they throw and no external call is ever attempted. No live
 * provider is verified or fabricated in this wave — wiring a real vendor
 * means implementing these interfaces behind the same tokens.
 */

export class ProviderNotConfiguredError extends ServiceUnavailableException {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNotConfiguredError';
  }
}

// ---------------------------------------------------------------------------
// Livestock insurance provider.

export interface LivestockInsuranceProvider {
  readonly provider: string;
  /** Binds a quoted policy with the underwriter; returns the provider ref. */
  bindPolicy(policy: InsurancePolicy): Promise<{ providerRef: string }>;
}

/**
 * Fail-closed stub. LIVESTOCK_INSURANCE_DRIVER is recognised but no
 * production underwriter driver ships in this wave, so every bind attempt
 * throws until a real driver is implemented and configured.
 */
export class FailClosedInsuranceProvider implements LivestockInsuranceProvider {
  readonly provider = 'stub';

  bindPolicy(): Promise<never> {
    return Promise.reject(
      new ProviderNotConfiguredError(
        'Livestock insurance provider is not configured (LIVESTOCK_INSURANCE_DRIVER + underwriter credentials); failing closed — no policy was bound externally'
      )
    );
  }
}

export function createLivestockInsuranceProvider(): LivestockInsuranceProvider {
  return new FailClosedInsuranceProvider();
}

// ---------------------------------------------------------------------------
// Cold-chain telemetry provider.

export interface ColdChainReading {
  pointId: string;
  recordedAt: string;
  temperatureCelsius: number;
  humidityPercent?: number;
}

export interface ColdChainProvider {
  readonly provider: string;
  /** Submits a temperature reading to the telemetry provider. */
  submitReading(reading: ColdChainReading): Promise<{ providerRef: string }>;
}

/** Fail-closed stub: throws until COLD_CHAIN_DRIVER + vendor credentials exist. */
export class FailClosedColdChainProvider implements ColdChainProvider {
  readonly provider = 'stub';

  submitReading(): Promise<never> {
    return Promise.reject(
      new ProviderNotConfiguredError(
        'Cold-chain telemetry provider is not configured (COLD_CHAIN_DRIVER + vendor credentials); failing closed — the reading was not ingested'
      )
    );
  }
}

export function createColdChainProvider(): ColdChainProvider {
  return new FailClosedColdChainProvider();
}
