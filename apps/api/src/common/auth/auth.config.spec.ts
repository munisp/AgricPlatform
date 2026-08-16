import { describe, expect, it } from 'vitest';
import { assertProductionAuthConfig, isProduction, loadOidcConfig } from './auth.config.js';

const BASE_ENV = {
  NODE_ENV: 'production',
  OIDC_ISSUER: 'https://keycloak.example.com/realms/agric-platform'
} as NodeJS.ProcessEnv;

describe('isProduction (normalised NODE_ENV guard)', () => {
  it('matches only the normalised production value', () => {
    expect(isProduction({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(true);
    // Casing/whitespace variants must still trip every fail-closed guard.
    expect(isProduction({ NODE_ENV: 'Production' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isProduction({ NODE_ENV: ' PRODUCTION ' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isProduction({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isProduction({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isProduction({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isProduction({ NODE_ENV: 'production2' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('assertProductionAuthConfig (G5)', () => {
  it('passes outside production even without OIDC', () => {
    expect(() => assertProductionAuthConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('throws in production without any OIDC issuer', () => {
    expect(() => assertProductionAuthConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /requires OIDC configuration/
    );
  });

  it('throws in production when the audience is missing', () => {
    expect(() => assertProductionAuthConfig({ ...BASE_ENV })).toThrow(/requires an OIDC audience/);
  });

  it('accepts OIDC_AUDIENCE or KEYCLOAK_CLIENT_ID as the audience', () => {
    expect(() =>
      assertProductionAuthConfig({ ...BASE_ENV, OIDC_AUDIENCE: 'agric-web' })
    ).not.toThrow();
    expect(() =>
      assertProductionAuthConfig({ ...BASE_ENV, KEYCLOAK_CLIENT_ID: 'agric-web' })
    ).not.toThrow();
  });

  it('loadOidcConfig derives issuer and audience from the Keycloak variables', () => {
    const config = loadOidcConfig({
      KEYCLOAK_URL: 'https://sso.example.com/',
      KEYCLOAK_REALM: 'nyfn',
      KEYCLOAK_CLIENT_ID: 'agric-web'
    } as NodeJS.ProcessEnv);
    expect(config?.issuer).toBe('https://sso.example.com/realms/nyfn');
    expect(config?.audience).toBe('agric-web');
  });
});
