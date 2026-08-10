import { createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import { isProduction } from '../../common/auth/auth.config.js';

/**
 * Farmer presence-proof (OTP) port (wave AGENTBANK), mirroring the repo's
 * fail-closed adapter doctrine (payments / mojaloop / flood-ml drivers).
 *
 * OTP_DRIVER=stub (default): DETERMINISTIC, clearly labelled development
 * driver — the expected code is derived from a stable hash of the farmer id
 * and the challenge reference, so tests and demos are reproducible. It is
 * NOT a real OTP channel: nothing is sent anywhere.
 *
 * OTP_DRIVER=live: reserved for a real OTP provider integration. It
 * REQUIRES OTP_PROVIDER_URL + OTP_PROVIDER_API_KEY and fails CLOSED: boot
 * aborts in production when they are missing, and every verification call
 * answers 503 (ServiceUnavailable) otherwise — never a silent pass.
 */

export const OTP_DRIVER_TOKEN = Symbol('AGENT_BANKING_OTP_DRIVER');

export interface OtpDriver {
  readonly name: 'stub' | 'live';
  /** Deterministic challenge code for the stub; undefined for live. */
  challengeCode(farmerId?: string, reference?: string): string | undefined;
  /** Throws when the proof is invalid or the channel is unavailable. */
  verify(farmerId: string, reference: string, code: string): Promise<void>;
}

/** Deterministic 6-digit stub code: stable per (farmerId, reference). */
export function stubOtpCode(farmerId: string, reference: string): string {
  const digest = createHash('sha256')
    .update(`agent-banking-stub-otp:${farmerId}:${reference}`)
    .digest();
  const value = digest.readUInt32BE(0) % 1_000_000;
  return value.toString().padStart(6, '0');
}

export class StubOtpDriver implements OtpDriver {
  readonly name = 'stub' as const;

  challengeCode(farmerId: string, reference: string): string {
    return stubOtpCode(farmerId, reference);
  }

  verify(farmerId: string, reference: string, code: string): Promise<void> {
    // async boundary: invalid proofs reject (never throw synchronously) so
    // callers can uniformly `await ... .rejects` the verification.
    return code === stubOtpCode(farmerId, reference)
      ? Promise.resolve()
      : Promise.reject(new OtpVerificationError());
  }
}

export class OtpVerificationError extends Error {
  constructor() {
    super('Invalid farmer presence proof (OTP)');
    this.name = 'OtpVerificationError';
  }
}

/**
 * Live driver placeholder: a real OTP provider is an EXTERNAL GATE (vendor
 * contract + DND routing). Until one is wired, every call fails closed with
 * 503 so no deployment can pretend to verify presence.
 */
export class LiveOtpDriver implements OtpDriver {
  readonly name = 'live' as const;

  constructor(
    private readonly providerUrl: string | undefined,
    private readonly apiKey: string | undefined
  ) {}

  challengeCode(_farmerId?: string, _reference?: string): undefined {
    return undefined;
  }

  verify(_farmerId: string, _reference: string, _code: string): Promise<never> {
    if (!this.providerUrl || !this.apiKey) {
      return Promise.reject(
        new ServiceUnavailableException(
          'OTP_DRIVER=live requires OTP_PROVIDER_URL and OTP_PROVIDER_API_KEY (fail-closed: no presence proof possible).'
        )
      );
    }
    // No provider client is integrated yet — fail closed rather than
    // silently accepting an unverifiable proof.
    return Promise.reject(
      new ServiceUnavailableException(
        'Live OTP provider client is not integrated in this build (fail-closed).'
      )
    );
  }
}

export function createOtpDriver(env: NodeJS.ProcessEnv = process.env): OtpDriver {
  const flag = (env.OTP_DRIVER ?? 'stub').trim().toLowerCase();
  if (flag === 'live') {
    const missing = ['OTP_PROVIDER_URL', 'OTP_PROVIDER_API_KEY'].filter((name) => !env[name]);
    if (isProduction() && missing.length > 0) {
      throw new ProviderConfigError('agent-banking-otp', missing);
    }
    return new LiveOtpDriver(env.OTP_PROVIDER_URL, env.OTP_PROVIDER_API_KEY);
  }
  // Fail closed (mirrors assertProductionDriverConfig): the stub code is a
  // PUBLICLY COMPUTABLE hash, so a stub OTP in production is a presence-proof
  // bypass. Boot aborts; OTP_DRIVER=live is the only production mode.
  if (isProduction()) {
    throw new ProviderConfigError('agent-banking-otp', [
      'OTP_DRIVER=live (the deterministic stub OTP is forbidden in production)'
    ]);
  }
  return new StubOtpDriver();
}
