import { createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import { VendorHttpClient, parseVendorTimeoutMs } from '../integrations/drivers/vendor-client.js';
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
 * OTP_DRIVER=live: OTP vendor client (WP-G17). It REQUIRES
 * OTP_PROVIDER_URL + OTP_PROVIDER_API_KEY (per-attempt timeout via
 * OTP_PROVIDER_TIMEOUT_MS, default 5000) and fails CLOSED: boot aborts in
 * production when they are missing, an unconfigured client answers 503 on
 * every call, and every vendor failure mode (timeout, transport, 4xx/5xx,
 * open circuit breaker, malformed response) maps to 503 — never a silent
 * pass. Resilience per platform pattern: AbortController timeout, circuit
 * breaker (3 fails/30s), bounded retry with jitter on transient 5xx only
 * (VendorHttpClient). Vendor request/response bodies carry the OTP code and
 * are never logged or echoed in errors.
 *
 * EXTERNAL GATE: real OTP vendor credentials are a MAINTAINER ACTION
 * (vendor contract + DND routing) — see apps/api/.env.example.
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
 * Vendor-agnostic presence-proof verification contract: POST {base}/verify
 * with { farmerId, reference, code } expects 200 JSON { valid: boolean }.
 * `valid: false` rejects with OtpVerificationError; a missing `valid` field
 * is a contract violation and fails closed with 503.
 */
interface OtpVendorVerifyResponse {
  valid?: boolean;
}

/**
 * Live driver (WP-G17): OTP vendor HTTP client scaffolding. Real vendor
 * credentials remain an EXTERNAL GATE (vendor contract + DND routing —
 * maintainer action); until configured, every call fails closed with 503 so
 * no deployment can pretend to verify presence.
 */
export class LiveOtpDriver implements OtpDriver {
  readonly name = 'live' as const;
  private readonly client?: VendorHttpClient;

  constructor(providerUrl?: string, apiKey?: string, timeoutMs?: number) {
    if (providerUrl && apiKey) {
      this.client = new VendorHttpClient({
        provider: 'agent-banking-otp',
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

  challengeCode(_farmerId?: string, _reference?: string): undefined {
    return undefined;
  }

  async verify(farmerId: string, reference: string, code: string): Promise<void> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'OTP_DRIVER=live requires OTP_PROVIDER_URL and OTP_PROVIDER_API_KEY (fail-closed: no presence proof possible).'
      );
    }
    let json: OtpVendorVerifyResponse;
    try {
      json = await this.client.postJson<OtpVendorVerifyResponse>('/verify', {
        farmerId,
        reference,
        code
      });
    } catch {
      // Timeout / transport / HTTP error / open breaker: one uniform
      // fail-closed answer; the underlying error carries no vendor body.
      throw new ServiceUnavailableException(
        'OTP provider request failed (fail-closed: timeout, transport error, HTTP error or open circuit breaker).'
      );
    }
    if (!json || typeof json.valid !== 'boolean') {
      throw new ServiceUnavailableException(
        'OTP provider returned a malformed verification response (fail-closed).'
      );
    }
    if (!json.valid) {
      throw new OtpVerificationError();
    }
  }
}

export function createOtpDriver(env: NodeJS.ProcessEnv = process.env): OtpDriver {
  const flag = (env.OTP_DRIVER ?? 'stub').trim().toLowerCase();
  if (flag === 'live') {
    const missing = ['OTP_PROVIDER_URL', 'OTP_PROVIDER_API_KEY'].filter((name) => !env[name]);
    if (isProduction() && missing.length > 0) {
      throw new ProviderConfigError('agent-banking-otp', missing);
    }
    return new LiveOtpDriver(
      env.OTP_PROVIDER_URL,
      env.OTP_PROVIDER_API_KEY,
      parseVendorTimeoutMs(env.OTP_PROVIDER_TIMEOUT_MS)
    );
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
