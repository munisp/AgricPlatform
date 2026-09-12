import { createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import { VendorHttpClient, parseVendorTimeoutMs } from '../integrations/drivers/vendor-client.js';
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
 * NIN_DRIVER=live: licensed identity vendor client (WP-G17). It REQUIRES
 * NIN_PROVIDER_URL + NIN_PROVIDER_API_KEY (per-attempt timeout via
 * NIN_PROVIDER_TIMEOUT_MS, default 5000) and fails CLOSED: boot aborts in
 * production when they are missing, an unconfigured client answers 503 on
 * every call, and every vendor failure mode (timeout, transport, 4xx/5xx,
 * open circuit breaker, malformed response) maps to 503 — never a silent
 * pass and never a silent stub substitution. Resilience per platform
 * pattern: AbortController timeout, circuit breaker (3 fails/30s), bounded
 * retry with jitter on transient 5xx only (VendorHttpClient). Vendor
 * request/response bodies carry PII and are never logged or echoed in
 * errors.
 *
 * EXTERNAL GATE: real NIMC/licensed identity vendor credentials are a
 * MAINTAINER ACTION (vendor contract + programme sponsor MOU — see
 * apps/api/src/modules/input-vouchers/README.md and docs/input-vouchers.md).
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
 * Vendor-agnostic NIN verification response contract: POST {base}/verify
 * with { nin, fullName, dateOfBirth? } expects 200 JSON { verified: boolean,
 * nameMatchScore?: number }. A missing `verified` field is a contract
 * violation and fails closed with 503 — never interpreted as a verdict.
 */
interface NinVendorVerifyResponse {
  verified?: boolean;
  nameMatchScore?: number;
}

/**
 * Live driver (WP-G17): vendor HTTP client scaffolding against the licensed
 * NIN identity vendor. Real credentials remain an EXTERNAL GATE (vendor
 * contract + sponsor MOU — maintainer action); until configured, every call
 * fails closed with 503 so no deployment can pretend to verify a NIN.
 */
export class LiveIdentityDriver implements IdentityVerificationPort {
  readonly name = 'live' as const;
  private readonly client?: VendorHttpClient;

  constructor(providerUrl?: string, apiKey?: string, timeoutMs?: number) {
    if (providerUrl && apiKey) {
      this.client = new VendorHttpClient({
        provider: 'nin-identity',
        baseUrl: providerUrl,
        apiKey,
        timeoutMs
      });
    }
  }

  /** Visible for tests/status: whether the circuit breaker is open. */
  get circuitOpen(): boolean {
    return this.client?.circuitOpen ?? false;
  }

  async verify(input: IdentityVerificationInput): Promise<IdentityVerificationResult> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'NIN_DRIVER=live requires NIN_PROVIDER_URL and NIN_PROVIDER_API_KEY (fail-closed: no identity verification possible).'
      );
    }
    let json: NinVendorVerifyResponse;
    try {
      json = await this.client.postJson<NinVendorVerifyResponse>('/verify', {
        nin: input.nin,
        fullName: input.fullName,
        dateOfBirth: input.dateOfBirth
      });
    } catch {
      // Timeout / transport / HTTP error / open breaker: one uniform
      // fail-closed answer; the underlying error carries no vendor body.
      throw new ServiceUnavailableException(
        'NIN identity provider request failed (fail-closed: timeout, transport error, HTTP error or open circuit breaker).'
      );
    }
    if (!json || typeof json.verified !== 'boolean') {
      throw new ServiceUnavailableException(
        'NIN identity provider returned a malformed verification response (fail-closed).'
      );
    }
    return {
      verified: json.verified,
      nameMatchScore: typeof json.nameMatchScore === 'number' ? json.nameMatchScore : undefined,
      basis: 'live'
    };
  }
}

export function createIdentityDriver(env: NodeJS.ProcessEnv = process.env): IdentityVerificationPort {
  const flag = (env.NIN_DRIVER ?? 'stub').trim().toLowerCase();
  if (flag === 'live') {
    const missing = ['NIN_PROVIDER_URL', 'NIN_PROVIDER_API_KEY'].filter((name) => !env[name]);
    if (isProduction() && missing.length > 0) {
      throw new ProviderConfigError('nin-identity', missing);
    }
    return new LiveIdentityDriver(
      env.NIN_PROVIDER_URL,
      env.NIN_PROVIDER_API_KEY,
      parseVendorTimeoutMs(env.NIN_PROVIDER_TIMEOUT_MS)
    );
  }
  // Fail closed (mirrors createOtpDriver / assertProductionDriverConfig): the
  // stub verdict is a PUBLICLY COMPUTABLE hash, so a stub identity check in
  // production would enrol anyone as a "verified" subsidy beneficiary. Boot
  // aborts; NIN_DRIVER=live is the only production mode.
  if (isProduction()) {
    throw new ProviderConfigError('nin-identity', [
      'NIN_DRIVER=live (the deterministic stub identity verification is forbidden in production)'
    ]);
  }
  return new StubIdentityDriver();
}
