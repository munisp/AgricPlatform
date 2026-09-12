/**
 * Real phone-auth token issuance via the Keycloak token endpoint
 * (Stage-2 follow-up: PIN-swap credential threading, backslash-free
 * re-baseline of the deferred pin-session work).
 *
 * Phone login (OTP verify, registration, shared-device PIN swap) previously
 * always issued a development stub token. Behind the PHONE_AUTH_KEYCLOAK
 * feature flag (default false) this service exchanges the platform-verified
 * second factor (OTP code or PIN) at the realm token endpoint
 * (<issuer>/protocol/openid-connect/token, direct access grant) and returns
 * the Keycloak-issued access token instead. The credential is threaded in
 * by the caller that already verified it (AuthService.verifyOtp threads the
 * consumed OTP code; PinSessionService.switchProfile threads the verified
 * PIN) — it is never re-verified here, never logged and never persisted.
 *
 * Resilience per the platform provider doctrine: the shared HTTP plumbing
 * (integrations/drivers/http.js) supplies a per-attempt AbortController
 * timeout (PHONE_AUTH_KEYCLOAK_TIMEOUT_MS, default 5000) and one OTel span
 * per outbound call with redacted attributes; this service adds a call-time
 * circuit breaker (3 consecutive failures / 30s cooldown, mirroring the
 * Mojaloop driver). No retries — a failed token exchange surfaces
 * immediately and the user retries the whole login flow.
 *
 * FAIL-CLOSED CONTRACT: every failure mode — timeout, transport error,
 * 4xx/5xx, open breaker, malformed response, missing credential — maps to
 * 503 AUTH_UNAVAILABLE. Enabled-but-unconfigured aborts boot with
 * ProviderConfigError (driver doctrine). Token material, the client secret
 * and the OTP/PIN credential are never logged: upstream error bodies are
 * discarded (not chained) before the uniform 503 is thrown, and the shared
 * HTTP plumbing never logs request bodies.
 *
 * EXTERNAL GATE (maintainer action): the realm needs a confidential client
 * with direct access grants plus a phone/OTP authenticator or
 * token-exchange policy, and users provisioned realm-side. Until that is
 * done the flag stays OFF and production phone logins fail closed with
 * 503 AUTH_UNAVAILABLE (see AuthService.issueAccessToken).
 */

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { loadOidcConfig } from '../../common/auth/auth.config.js';
import {
  PROVIDER_TIMEOUT_MS,
  ProviderConfigError,
  httpRequest
} from '../integrations/drivers/http.js';

export const PHONE_AUTH_KEYCLOAK_PROVIDER = 'phone-auth-keycloak';

/** Error label required by the fail-closed contract: 503 AUTH_UNAVAILABLE. */
export const AUTH_UNAVAILABLE = 'AUTH_UNAVAILABLE';

/** Consecutive failures before the circuit opens (mirrors Mojaloop driver). */
export const PHONE_AUTH_CIRCUIT_THRESHOLD = 3;
/** How long the circuit stays open before the next call is allowed through. */
export const PHONE_AUTH_CIRCUIT_COOLDOWN_MS = 30 * 1000;

interface KeycloakTokenResponse {
  access_token?: string;
}

export interface KeycloakPhoneAuthConfig {
  enabled: boolean;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  timeoutMs: number;
}

/** Parses PHONE_AUTH_KEYCLOAK_TIMEOUT_MS; falls back to the provider default. */
function parseTimeoutMs(raw?: string): number {
  if (!raw) {
    return PROVIDER_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PROVIDER_TIMEOUT_MS;
}

/** Resolves the flagged phone-auth Keycloak configuration from the environment. */
export function loadKeycloakPhoneAuthConfig(
  env: NodeJS.ProcessEnv = process.env
): KeycloakPhoneAuthConfig {
  const enabled = (env.PHONE_AUTH_KEYCLOAK ?? '').trim().toLowerCase() === 'true';
  if (!enabled) {
    return { enabled: false, timeoutMs: PROVIDER_TIMEOUT_MS };
  }
  return {
    enabled: true,
    issuer: loadOidcConfig(env)?.issuer,
    clientId: env.KEYCLOAK_CLIENT_ID,
    clientSecret: env.KEYCLOAK_CLIENT_SECRET,
    timeoutMs: parseTimeoutMs(env.PHONE_AUTH_KEYCLOAK_TIMEOUT_MS)
  };
}

function authUnavailable(detail?: string): ServiceUnavailableException {
  const suffix = detail ? ` ${detail}` : '';
  return new ServiceUnavailableException(
    `${AUTH_UNAVAILABLE}: phone authentication token issuance is unavailable.${suffix}`
  );
}

@Injectable()
export class KeycloakPhoneTokenService {
  readonly enabled: boolean;
  private readonly tokenUrl?: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly timeoutMs: number;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const config = loadKeycloakPhoneAuthConfig(env);
    this.enabled = config.enabled;
    this.timeoutMs = config.timeoutMs;
    if (!config.enabled) {
      return;
    }
    const missing: string[] = [];
    if (!config.issuer) {
      missing.push('OIDC_ISSUER (or KEYCLOAK_URL + KEYCLOAK_REALM)');
    }
    if (!config.clientId) {
      missing.push('KEYCLOAK_CLIENT_ID');
    }
    if (missing.length > 0 || !config.issuer || !config.clientId) {
      // Enabled-but-unconfigured: boot aborts (fail closed, driver doctrine).
      throw new ProviderConfigError(PHONE_AUTH_KEYCLOAK_PROVIDER, missing);
    }
    // Strip one trailing slash with plain string ops (no regex, no
    // backslashes — the patch channel cannot transmit them byte-exactly).
    const issuer = config.issuer.endsWith('/') ? config.issuer.slice(0, -1) : config.issuer;
    this.tokenUrl = `${issuer}/protocol/openid-connect/token`;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
  }

  /** Visible for tests/status: whether the circuit breaker is open. */
  get circuitOpen(): boolean {
    return (
      this.consecutiveFailures >= PHONE_AUTH_CIRCUIT_THRESHOLD &&
      Date.now() < this.circuitOpenUntil
    );
  }

  /**
   * Exchanges the platform-verified second factor (OTP code or PIN) at the
   * Keycloak token endpoint (direct access grant, username = phone). Every
   * failure mode maps to 503 AUTH_UNAVAILABLE; a missing credential means
   * the caller has no verified factor to exchange (fail closed).
   */
  async issueToken(user: User, credential?: string): Promise<string> {
    if (!this.enabled || !this.tokenUrl || !this.clientId) {
      throw authUnavailable('Keycloak phone-auth issuance is not configured.');
    }
    if (!credential) {
      throw authUnavailable(
        'Keycloak phone-auth issuance requires the verified second factor (OTP code or PIN).'
      );
    }
    this.assertCircuitClosed();
    const form: Record<string, string> = {
      grant_type: 'password',
      client_id: this.clientId,
      username: user.phone,
      password: credential
    };
    if (this.clientSecret) {
      form['client_secret'] = this.clientSecret;
    }
    try {
      const response = await httpRequest(PHONE_AUTH_KEYCLOAK_PROVIDER, this.tokenUrl, {
        form,
        timeoutMs: this.timeoutMs
      });
      const json = response.json as KeycloakTokenResponse | undefined;
      if (!json || typeof json.access_token !== 'string' || json.access_token.length === 0) {
        throw authUnavailable('Identity provider returned a malformed token response.');
      }
      this.recordSuccess();
      return json.access_token;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        // Our own uniform 503 (malformed response): still a provider-side
        // failure, so the breaker hears about it.
        this.recordFailure();
        throw error;
      }
      // Timeout / transport / HTTP failure: one uniform fail-closed answer.
      // The upstream error (which may carry a truncated response body) is
      // deliberately NOT chained into the thrown error — redaction doctrine.
      this.recordFailure();
      throw authUnavailable();
    }
  }

  private assertCircuitClosed(): void {
    if (this.circuitOpen) {
      throw authUnavailable(
        `Identity provider circuit is open after ${this.consecutiveFailures} consecutive failures; retry after cooldown.`
      );
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= PHONE_AUTH_CIRCUIT_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + PHONE_AUTH_CIRCUIT_COOLDOWN_MS;
    }
  }
}
