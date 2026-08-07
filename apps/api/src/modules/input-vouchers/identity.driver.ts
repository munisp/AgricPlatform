import { createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import { isProduction } from '../../common/auth/auth.config.js';
import { InvalidNinError, normalizeNin } from './nin-crypto.js';

/**
 * Identity verification port for the NIN-linked input subsidy rail
 * (wave NINVOUCHER), mirroring the repo's fail-closed adapter doctrine
 * (payments / mojaloop / agent-banking OTP drivers).
 *
 * NIN_DRIVER=stub (default): DETERMINISTIC, clearly labelled development
 * driver — the verification result is a pure function of a stable SHA-256
 * hash of the NIN, so tests and demos are reproducible. It is NOT a real
 * identity check: nothing is queried anywhere and `basis: 'stub'` labels
 * every result honestly (API fields, UI badges, docs).
 *
 * NIN_DRIVER=live: reserved for NIMC or a licensed identity vendor. It
 * REQUIRES NIN_PROVIDER_URL + NIN_PROVIDER_API_KEY and fails CLOSED: boot
 * aborts in production when they are missing, and every verification call
 * answers 503 (ServiceUnavailable) until a vendor client is integrated —
 * never a silent pass and never a silent stub substitution.
 *
 * EXTERNAL GATE: NIMC/licensed identity vendor contract + programme sponsor
 * MOU (see apps/api/src/modules/input-vouchers/README.md and
 * docs/input-vouchers.md).
 */

export const IDENTITY_VERIFICATION_PORT = Symbol('INPUT_VOUCHERS_IDENTITY_VERIFICATION');

export interface IdentityVerificationInput {
  /** Plaintext NIN — used for the call only, never persisted. */
  nin: string;
  fullName: string;
  dateOfBirth?: string;
}

export interface IdentityVerificationResult {
  verified: boolean;
  /** 0–100 name-match confidence when the driver computed one. */
  nameMatchScore?: number;
  /** Honest provenance label. */
  basis: 'stub' | 'live';
}

export interface IdentityVerificationPort {
  readonly name: 'stub' | 'live';
  verify(input: IdentityVerificationInput): Promise<IdentityVerificationResult>;
}

/**
 * Deterministic labelled stub: a NIN "verifies" when 7/8 of the hash space
 * says so (stable per NIN), and the name-match score is hash-derived in
 * 55–99. Malformed NINs never verify. Pure function so tests can compute
 * the expected outcome for any NIN without mocking.
 */
export function stubIdentityResult(nin: string): IdentityVerificationResult {
  let normalized: string;
  try {
    normalized = normalizeNin(nin);
  } catch (error) {
    if (error instanceof InvalidNinError) {
      return { verified: false, nameMatchScore: 0, basis: 'stub' };
    }
    throw error;
  }
  const digest = createHash('sha256').update(`input-vouchers-stub-identity:${normalized}`).digest();
  const verified = digest[0] % 8 !== 0;
  const nameMatchScore = verified ? 55 + (digest[1] % 45) : digest[1] % 50;
  return { verified, nameMatchScore, basis: 'stub' };
}

export class StubIdentityDriver implements IdentityVerificationPort {
  readonly name = 'stub' as const;

  verify(input: IdentityVerificationInput): Promise<IdentityVerificationResult> {
    // async boundary so callers can uniformly `await ... .rejects`.
    return Promise.resolve(stubIdentityResult(input.nin));
  }
}

/**
 * Live driver placeholder: a real NIMC/licensed vendor integration is an
 * EXTERNAL GATE (vendor contract + sponsor MOU). Until one is wired, every
 * call fails closed with 503 so no deployment can pretend to verify a NIN.
 */
export class LiveIdentityDriver implements IdentityVerificationPort {
  readonly name = 'live' as const;

  constructor(
    private readonly providerUrl: string | undefined,
    private readonly apiKey: string | undefined
  ) {}

  verify(_input: IdentityVerificationInput): Promise<never> {
    if (!this.providerUrl || !this.apiKey) {
      return Promise.reject(
        new ServiceUnavailableException(
          'NIN_DRIVER=live requires NIN_PROVIDER_URL and NIN_PROVIDER_API_KEY (fail-closed: no identity verification possible).'
        )
      );
    }
    // No vendor client is integrated yet — fail closed rather than silently
    // accepting an unverifiable identity.
    return Promise.reject(
      new ServiceUnavailableException(
        'Live NIN identity provider client is not integrated in this build (fail-closed).'
      )
    );
  }
}

export function createIdentityDriver(env: NodeJS.ProcessEnv = process.env): IdentityVerificationPort {
  const flag = (env.NIN_DRIVER ?? 'stub').trim().toLowerCase();
  if (flag === 'live') {
    const missing = ['NIN_PROVIDER_URL', 'NIN_PROVIDER_API_KEY'].filter((name) => !env[name]);
    if (isProduction() && missing.length > 0) {
      throw new ProviderConfigError('nin-identity', missing);
    }
    return new LiveIdentityDriver(env.NIN_PROVIDER_URL, env.NIN_PROVIDER_API_KEY);
  }
  return new StubIdentityDriver();
}
