import { Injectable } from '@nestjs/common';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey
} from 'jose';
import { USER_ROLES, type UserRole } from '@agric-platform/shared';
import { loadOidcConfig, type OidcConfig } from './auth.config.js';

export interface OidcIdentity {
  /** Token subject (Keycloak user id). */
  subject: string;
  /** Platform roles carried by the token (realm + client roles). */
  roles: UserRole[];
  /** Display name claim when present. */
  name?: string;
  /** Raw verified claims for downstream auditing. */
  claims: JWTPayload;
}

interface KeycloakRealmAccess {
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
}

const KNOWN_ROLES = new Set<string>(USER_ROLES);

/**
 * Keycloak OIDC JWT verifier (docs/security-compliance.md §1). Tokens are
 * verified locally against the realm JWKS — issuer, audience, expiry and
 * signature — without round-tripping to the auth server on every request.
 */
@Injectable()
export class OidcService {
  private config: OidcConfig | null;
  private jwks: JWTVerifyGetKey | null = null;

  constructor() {
    this.config = loadOidcConfig();
  }

  /** Test/local factory with an explicit configuration (bypasses env). */
  static forConfig(config: OidcConfig | null): OidcService {
    const service = new OidcService();
    service.config = config;
    return service;
  }

  /** True when OIDC verification is configured (required in production). */
  get configured(): boolean {
    return this.config !== null;
  }

  /**
   * Verifies a bearer token and returns the caller identity.
   * Throws (with the underlying jose error) on any verification failure;
   * callers should translate that into a 401.
   */
  async verify(token: string): Promise<OidcIdentity> {
    if (!this.config) {
      throw new Error('OIDC is not configured; bearer tokens cannot be verified');
    }
    const { payload } = await jwtVerify(token, this.keySet(), {
      issuer: this.config.issuer,
      audience: this.config.audience
    });
    if (!payload.sub) {
      throw new Error('OIDC token is missing the sub claim');
    }
    return {
      subject: payload.sub,
      roles: this.extractRoles(payload),
      name: typeof payload.name === 'string' ? payload.name : undefined,
      claims: payload
    };
  }

  private keySet(): JWTVerifyGetKey {
    if (!this.jwks) {
      const config = this.config;
      if (!config) {
        throw new Error('OIDC is not configured');
      }
      this.jwks = config.jwksJson
        ? createLocalJWKSet(JSON.parse(config.jwksJson) as Parameters<typeof createLocalJWKSet>[0])
        : createRemoteJWKSet(new URL(config.jwksUri));
    }
    return this.jwks;
  }

  /** Maps Keycloak realm/client roles onto the canonical platform role set. */
  private extractRoles(payload: JWTPayload): UserRole[] {
    const claims = payload as JWTPayload & KeycloakRealmAccess;
    const raw = new Set<string>();
    for (const role of claims.realm_access?.roles ?? []) {
      raw.add(role);
    }
    const clientId = this.config?.audience;
    if (clientId) {
      for (const role of claims.resource_access?.[clientId]?.roles ?? []) {
        raw.add(role);
      }
    } else {
      for (const entry of Object.values(claims.resource_access ?? {})) {
        for (const role of entry.roles ?? []) {
          raw.add(role);
        }
      }
    }
    return [...raw].filter((role): role is UserRole => KNOWN_ROLES.has(role));
  }
}
