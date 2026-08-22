/**
 * Centralised authentication/OIDC configuration.
 *
 * Production identity is Keycloak OIDC: the API verifies JWT bearer tokens
 * against the realm JWKS (docs/security-compliance.md §1). The legacy
 * `x-user-id` development header is honoured only outside production or when
 * `ALLOW_DEV_HEADER_AUTH=true` is set explicitly.
 */

export interface OidcConfig {
  /** Expected token issuer (Keycloak realm URL). */
  issuer: string;
  /** JWKS endpoint used to verify token signatures. */
  jwksUri: string;
  /** Expected audience (client id). Optional but recommended. */
  audience?: string;
  /**
   * Inline JWKS JSON (tests/local only). When set, signature verification
   * uses this key set instead of fetching the remote JWKS endpoint.
   */
  jwksJson?: string;
}

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  // Normalised once, here: every production guard in the codebase routes
  // through this helper so casing/whitespace variants ('Production',
  // ' production ') cannot slip past a fail-closed check.
  return (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

/**
 * Minimum acceptable length for production HMAC signing secrets (agent
 * vouchers, NIN hash salt, warehouse receipts, livestock passports,
 * attendance/vet signing). 32 chars ≈ 128 bits of base64/hex entropy;
 * anything shorter is offline-brute-forceable from observed signatures.
 */
export const PRODUCTION_HMAC_SECRET_MIN_LENGTH = 32;

/** Minimum acceptable length for other production shared/webhook secrets. */
export const PRODUCTION_SHARED_SECRET_MIN_LENGTH = 16;

export interface ProductionSecretStrengthOptions {
  /** Length floor enforced in production (default 16). */
  minLength?: number;
  /**
   * Published development defaults / placeholders that must NEVER be
   * accepted in production, no matter their length (they are committed in
   * the repo, so their entropy is zero).
   */
  publishedDefaults?: readonly string[];
  /**
   * When false an UNSET variable stays legal (per-request guards fail
   * closed instead); a set value is still strength-checked. Default true.
   */
  required?: boolean;
}

/**
 * Fail-closed production strength gate for shared/HMAC secrets (audit
 * A3-2/A3-3/A3-5). In production a configured secret must (a) be present
 * when `required`, (b) not equal any published development default, and
 * (c) meet the length floor. No-op outside production. Throws a
 * descriptive error so misconfigured pods never serve traffic.
 */
export function assertProductionSecretStrength(
  env: NodeJS.ProcessEnv,
  name: string,
  options: ProductionSecretStrengthOptions = {}
): void {
  if (!isProduction(env)) {
    return;
  }
  const value = env[name]?.trim();
  const minLength = options.minLength ?? PRODUCTION_SHARED_SECRET_MIN_LENGTH;
  if (!value) {
    if (options.required === false) {
      return;
    }
    throw new Error(
      `FATAL: NODE_ENV=production requires ${name} (>= ${minLength} chars, high entropy). ` +
        'Refusing to run with the development default.'
    );
  }
  if (options.publishedDefaults?.includes(value)) {
    throw new Error(
      `FATAL: ${name} is set to the PUBLISHED development default, which is committed in ` +
        'the repository and has zero entropy. Provision a unique high-entropy secret via ' +
        'the deployment secret store. Refusing to start.'
    );
  }
  if (value.length < minLength) {
    throw new Error(
      `FATAL: ${name} must be at least ${minLength} characters in production ` +
        `(got ${value.length}). Short secrets are offline-brute-forceable from observed ` +
        'signatures. Refusing to start.'
    );
  }
}

/** The x-user-id development stub is never acceptable in production by default. */
export function devHeaderAuthAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isProduction(env) || env.ALLOW_DEV_HEADER_AUTH === 'true';
}

/**
 * Resolves OIDC configuration from the environment. Returns null when OIDC
 * is not configured (acceptable only outside production).
 *
 * Accepted variables:
 * - `OIDC_ISSUER` (or derived from `KEYCLOAK_URL` + `KEYCLOAK_REALM`)
 * - `OIDC_JWKS_URI` (defaults to the Keycloak realm certs endpoint)
 * - `OIDC_AUDIENCE` (or `KEYCLOAK_CLIENT_ID`)
 * - `OIDC_JWKS_JSON` (inline JWKS for tests/local development)
 */
export function loadOidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuer =
    env.OIDC_ISSUER ??
    (env.KEYCLOAK_URL
      ? `${env.KEYCLOAK_URL.replace(/\/$/, '')}/realms/${env.KEYCLOAK_REALM ?? 'agric-platform'}`
      : undefined);
  if (!issuer) {
    return null;
  }
  return {
    issuer,
    jwksUri: env.OIDC_JWKS_URI ?? `${issuer}/protocol/openid-connect/certs`,
    audience: env.OIDC_AUDIENCE ?? env.KEYCLOAK_CLIENT_ID,
    jwksJson: env.OIDC_JWKS_JSON
  };
}

/**
 * Fail-closed boot check: production deployments must have OIDC configured.
 * Throws a descriptive error so misconfigured pods never accept traffic.
 */
export function assertProductionAuthConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProduction(env)) {
    return;
  }
  const config = loadOidcConfig(env);
  if (!config) {
    throw new Error(
      'FATAL: NODE_ENV=production requires OIDC configuration. Set OIDC_ISSUER ' +
        '(or KEYCLOAK_URL + KEYCLOAK_REALM) so bearer tokens can be verified. ' +
        'Refusing to start with header-based identity in production.'
    );
  }
  if (!config.audience) {
    // Without an audience, jwtVerify skips the aud check (any client of the
    // realm is accepted) and role extraction would aggregate client roles
    // from every entry in resource_access — both unacceptable in production.
    throw new Error(
      'FATAL: NODE_ENV=production requires an OIDC audience. Set OIDC_AUDIENCE ' +
        '(or KEYCLOAK_CLIENT_ID) so bearer tokens are verified against the intended ' +
        'client and client-role extraction is scoped to it.'
    );
  }
  if (env.ALLOW_DEV_HEADER_AUTH === 'true') {
    // Loud but non-fatal: explicit operator opt-in (e.g. break-glass drills).
    console.warn(
      'WARNING: ALLOW_DEV_HEADER_AUTH=true in production — x-user-id header auth is enabled. ' +
        'Disable this flag for normal operation.'
    );
  }
}
