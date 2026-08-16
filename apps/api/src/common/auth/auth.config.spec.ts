import { describe, expect, it } from 'vitest';
import { assertProductionAuthConfig, loadOidcConfig } from './auth.config.js';

const BASE_ENV = {
  NODE_ENV: 'production',
  OIDC_ISSUER: 'https://keycloak.example.com/realms/agric-platform'
} as NodeJS.ProcessEnv;

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

  it('throws in production when ALLOW_DEV_HEADER_AUTH=true (C2: header auth is unverified identity)', () => {
    expect(() =>
      assertProductionAuthConfig({
        ...BASE_ENV,
        OIDC_AUDIENCE: 'agric-web',
        ALLOW_DEV_HEADER_AUTH: 'true'
      })
    ).toThrow(/ALLOW_DEV_HEADER_AUTH=true is forbidden/);
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
