import { describe, expect, it } from 'vitest';
import { envChecks, runVerifyDeployment } from '../../../../scripts/verify-deployment.mjs';

const COMPLETE_ENV = {
  OIDC_ISSUER: 'https://idp.example/realms/agric',
  OIDC_AUDIENCE: 'agric-api',
  DATABASE_URL: 'postgres://u:p@h/db',
  REDIS_URL: 'redis://h',
  ATTENDANCE_SIGNING_SECRET: 'a-very-strong-secret',
  VET_SIGNING_SECRET: 'another-strong-secret',
  API_BASE_URL: 'https://api.example/api/v1'
};

const silent = () => {};
const passProviders = async () => [
  { name: 'postgres', status: 'PASS', detail: 'current' },
  { name: 'redis', status: 'PASS', detail: 'PONG' }
];
const readyFetch = async () =>
  ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) }) as Response;

describe('verify-deployment envChecks', () => {
  it('passes with the complete production env', () => {
    const problems = envChecks.map((c) => c.problem(COMPLETE_ENV)).filter(Boolean);
    expect(problems).toEqual([]);
  });

  it('flags every missing required variable by name', () => {
    const problems = envChecks
      .map((c) => ({ name: c.name, problem: c.problem({}) }))
      .filter((c) => c.problem);
    const names = problems.map((p) => p.name);
    expect(names).toContain('env:oidc-issuer');
    expect(names).toContain('env:oidc-audience');
    expect(names).toContain('env:database-url');
    expect(names).toContain('env:redis-url');
    expect(names).toContain('env:attendance-signing-secret');
    expect(names).toContain('env:vet-signing-secret');
  });

  it('accepts break-glass in-memory flags instead of URLs (with warning handled by runner)', () => {
    const env = { ...COMPLETE_ENV, DATABASE_URL: '', REDIS_URL: '', ALLOW_INMEMORY_PERSISTENCE: 'true', ALLOW_INMEMORY_CACHE: 'true' };
    const problems = envChecks.map((c) => c.problem(env)).filter(Boolean);
    expect(problems).toEqual([]);
  });

  it('flags non-stub integration drivers without credentials', () => {
    const env = { ...COMPLETE_ENV, SMS_DRIVER: 'termii' };
    const problems = envChecks.map((c) => c.problem(env)).filter(Boolean);
    expect(problems.some((p) => p?.includes('termii'))).toBe(true);
    // Providing the credential clears it.
    const fixed = envChecks.map((c) => c.problem({ ...env, TERMII_API_KEY: 'x' })).filter(Boolean);
    expect(fixed).toEqual([]);
  });

  it('flags PARTNER_API_DRIVER=live without a signing secret', () => {
    const env = { ...COMPLETE_ENV, PARTNER_API_DRIVER: 'live' };
    const problems = envChecks.map((c) => c.problem(env)).filter(Boolean);
    expect(problems.some((p) => p?.includes('PARTNER_API_SIGNING_SECRET'))).toBe(true);
  });
});

describe('verify-deployment runVerifyDeployment', () => {
  it('passes when env is complete, providers pass and /health/ready responds', async () => {
    const { ok } = await runVerifyDeployment(COMPLETE_ENV, {
      fetch: readyFetch,
      runProviders: passProviders,
      log: silent
    });
    expect(ok).toBe(true);
  });

  it('fails when a required env var is missing', async () => {
    const { ok, results } = await runVerifyDeployment(
      { ...COMPLETE_ENV, OIDC_AUDIENCE: '' },
      { fetch: readyFetch, runProviders: passProviders, log: silent }
    );
    expect(ok).toBe(false);
    expect(results.find((r) => r.name === 'env:oidc-audience')?.status).toBe('FAIL');
  });

  it('fails when the migration level check fails', async () => {
    const { ok } = await runVerifyDeployment(COMPLETE_ENV, {
      fetch: readyFetch,
      runProviders: async () => [
        { name: 'postgres', status: 'FAIL', detail: 'behind' },
        { name: 'redis', status: 'PASS', detail: 'PONG' }
      ],
      log: silent
    });
    expect(ok).toBe(false);
  });

  it('fails when /health/ready is unreachable or non-200', async () => {
    const unreachable = await runVerifyDeployment(COMPLETE_ENV, {
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
      runProviders: passProviders,
      log: silent
    });
    expect(unreachable.ok).toBe(false);

    const degraded = await runVerifyDeployment(COMPLETE_ENV, {
      fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response,
      runProviders: passProviders,
      log: silent
    });
    expect(degraded.ok).toBe(false);
    expect(degraded.results.find((r) => r.name === 'api:health-ready')?.detail).toContain('503');
  });
});
