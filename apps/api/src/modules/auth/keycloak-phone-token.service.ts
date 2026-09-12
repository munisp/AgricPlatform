/**
 * WP-G16: real phone-auth token issuance via the Keycloak token endpoint.
 *
 * The phone-OTP/PIN login previously always issued a development stub token.
 * Behind the PHONE_AUTH_KEYCLOAK feature flag (default false) this service
 * exchanges the platform-verified second factor (OTP code or PIN) at the
 * realm token endpoint (<issuer>/protocol/openid-connect/token, direct
 * access grant) and returns the Keycloak-issued access token instead.
 *
 * Resilience per platform pattern (VendorHttpClient): AbortController
 * timeout per attempt (PHONE_AUTH_KEYCLOAK_TIMEOUT_MS, default 5000) and a
 * call-time circuit breaker (3 consecutive failures / 30s cooldown). No
 * retries here — a failed token exchange surfaces immediately.
 *
 * FAIL-CLOSED CONTRACT: every failure mode — timeout, transport error,
 * 4xx/5xx, open breaker, malformed response, missing credential — maps to
 * 503 AUTH_UNAVAILABLE. Enabled-but-unconfigured aborts boot with
 * ProviderConfigError (driver doctrine). Token material, the client secret
 * and the OTP/PIN credential are never logged: the vendor client strips
 * response bodies from errors and the shared HTTP plumbing never logs
 * request bodies.
 *
 * EXTERNAL GATE (maintainer action): the realm needs a confidential client
 * (infra/keycloak realm export: agric-api) with direct access grants plus a
 * phone/OTP authenticator or token-exchange policy, and users provisioned
 * realm-side. Until that is done the flag stays OFF and production phone
 * logins fail closed with 503 AUTH_UNAVAILABLE (see AuthService).
 */

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { loadOidcConfig } from '../../common/auth/auth.config.js';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import {
  VendorHttpClient,
  parseVendorTimeoutMs
} from '../integrations/drivers/vendor-client.js';

export const PHONE_AUTH_KEYCLOAK_PROVIDER = 'phone-auth-keycloak';

/** Error label required by the fail-closed contract: 503 AUTH_UNAVAILABLE. */
export const AUTH_UNAVAILABLE = 'AUTH_UNAVAILABLE';

interface KeycloakTokenResponse {
  access_token?: string;
}

export interface KeycloakPhoneAuthConfig {
  enabled: boolean;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  timeoutMs?: number;
}

/** Resolves the flagged phone-auth Keycloak configuration from the environment. */
export function loadKeycloakPhoneAuthConfig(
  env: NodeJS.ProcessEnv = process.env
): KeycloakPhoneAuthConfig {
  const enabled = (env.PHONE_AUTH_KEYCLOAK ?? '').trim().toLowerCase() === 'true';
  if (!enabled) {
    return { enabled: false };
  }
  return {
    enabled: true,
    issuer: loadOidcConfig(env)?.issuer,
    clientId: env.KEYCLOAK_CLIENT_ID,
    clientSecret: env.KEYCLOAK_CLIENT_SECRET,
    timeoutMs: parseVendorTimeoutMs(env.PHONE_AUTH_KEYCLOAK_TIMEOUT_MS)
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
  private readonly issuer?: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly client?: VendorHttpClient;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const config = loadKeycloakPhoneAuthConfig(env);
    this.enabled = config.enabled;
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
    this.issuer = config.issuer;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.client = new VendorHttpClient({
      provider: PHONE_AUTH_KEYCLOAK_PROVIDER,
      baseUrl: config.issuer,
      timeoutMs: config.timeoutMs,
      // Token issuance is not retried: a login attempt surfaces the failure
      // immediately and the user retries the whole OTP flow.
      maxRetries: 0
    });
  }

  /** Visible for tests/status: whether the circuit breaker is open. */
  get circuitOpen(): boolean {
    return this.client?.circuitOpen ?? false;
  }

  /**
   * Exchanges the platform-verified second factor (OTP code or PIN) at the
   * Keycloak token endpoint (direct access grant, username = phone). Every
   * failure mode maps to 503 AUTH_UNAVAILABLE; a missing credential means
   * the caller has no verified factor to exchange (fail closed).
   */
  async issueToken(user: User, credential?: string): Promise<string> {
    if (!this.enabled || !this.client || !this.issuer || !this.clientId) {
      throw authUnavailable('Keycloak phone-auth issuance is not configured.');
    }
    if (!credential) {
      throw authUnavailable(
        'Keycloak phone-auth issuance requires the verified second factor (OTP code or PIN).'
      );
    }
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
      const json = await this.client.postForm<KeycloakTokenResponse>(
        '/protocol/openid-connect/token',
        form
      );
      if (!json || typeof json.access_token !== 'string' || json.access_token.length === 0) {
        throw authUnavailable('Identity provider returned a malformed token response.');
      }
      return json.access_token;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      // Timeout / transport / HTTP / open breaker: one uniform fail-closed
      // answer. The underlying error classes carry no response bodies
      // (redacted by VendorHttpClient) and no credentials.
      throw authUnavailable();
    }
  }
}
