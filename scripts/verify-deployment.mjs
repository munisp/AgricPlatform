#!/usr/bin/env node
/**
 * Deployment verification gate (Wave OPS). Run AFTER deploying to validate
 * the environment the API is booting into:
 *
 *   1. every production-required env var is present (mirrors the fail-closed
 *      boot guards in apps/api/src/main.ts: OIDC issuer + audience,
 *      DATABASE_URL, REDIS_URL, signing secrets, non-stub integration
 *      driver credentials, live partner-API signing secret);
 *   2. database migration level is current vs infra/postgres/*.sql
 *      (delegated to scripts/verify-providers.mjs);
 *   3. GET {API_BASE_URL}/health/ready responds HTTP 200.
 *
 * Exit 0 only when every check passes. Never prints secret values.
 *
 * Environment:
 *   API_BASE_URL   e.g. https://api.example.com/api/v1
 *                  (default http://localhost:3001/api/v1)
 *   + the production env being validated (see envChecks below).
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runChecks } from './verify-providers.mjs';

/**
 * The production-required configuration, mirroring the boot guards. Each
 * check returns null when satisfied or a human-readable problem string.
 * Keep this list in sync with apps/api/src/main.ts + config/*.ts guards.
 */
export const envChecks = [
  {
    name: 'env:oidc-issuer',
    problem: (env) =>
      env.OIDC_ISSUER || env.KEYCLOAK_URL
        ? null
        : 'OIDC_ISSUER (or KEYCLOAK_URL[+KEYCLOAK_REALM]) missing — production boot refuses header auth'
  },
  {
    name: 'env:oidc-audience',
    problem: (env) =>
      env.OIDC_AUDIENCE || env.KEYCLOAK_CLIENT_ID
        ? null
        : 'OIDC_AUDIENCE (or KEYCLOAK_CLIENT_ID) missing — production boot requires an audience'
  },
  {
    name: 'env:database-url',
    problem: (env) =>
      env.DATABASE_URL
        ? null
        : env.ALLOW_INMEMORY_PERSISTENCE === 'true'
          ? null // break-glass; flagged separately below
          : 'DATABASE_URL missing (ALLOW_INMEMORY_PERSISTENCE is a break-glass drill flag, not a deployment)'
  },
  {
    name: 'env:redis-url',
    problem: (env) =>
      env.REDIS_URL
        ? null
        : env.ALLOW_INMEMORY_CACHE === 'true'
          ? null
          : 'REDIS_URL missing (ALLOW_INMEMORY_CACHE is a break-glass drill flag, not a deployment)'
  },
  {
    name: 'env:attendance-signing-secret',
    problem: (env) =>
      (env.ATTENDANCE_SIGNING_SECRET ?? '').length >= 16
        ? null
        : 'ATTENDANCE_SIGNING_SECRET missing or < 16 chars — QR attendance tokens would be forgeable'
  },
  {
    name: 'env:vet-signing-secret',
    problem: (env) =>
      (env.VET_SIGNING_SECRET ?? '').length >= 16
        ? null
        : 'VET_SIGNING_SECRET missing or < 16 chars — vet health attestations would be forgeable'
  },
  {
    name: 'env:partner-api-signing-secret',
    problem: (env) =>
      env.PARTNER_API_DRIVER === 'live' && !env.PARTNER_API_SIGNING_SECRET
        ? 'PARTNER_API_DRIVER=live without PARTNER_API_SIGNING_SECRET'
        : null
  },
  // Non-stub integration drivers must carry credentials (mirrors
  // assertProductionDriverConfig in modules/integrations/adapters.ts).
  ...[
    { flag: 'SMS_DRIVER', altFlag: 'TERMII_DRIVER', creds: ['TERMII_API_KEY', 'TWILIO_ACCOUNT_SID'], provider: 'termii' },
    { flag: 'WHATSAPP_DRIVER', altFlag: null, creds: ['WHATSAPP_360DIALOG_API_KEY'], provider: 'whatsapp' },
    { flag: 'EMAIL_DRIVER', altFlag: 'MAILGUN_DRIVER', creds: ['MAILGUN_API_KEY', 'SENDGRID_API_KEY'], provider: 'mailgun' },
    { flag: 'PUSH_DRIVER', altFlag: 'ONESIGNAL_DRIVER', creds: ['ONESIGNAL_REST_API_KEY'], provider: 'onesignal' },
    { flag: 'LMS_DRIVER', altFlag: 'MOODLE_DRIVER', creds: ['MOODLE_TOKEN'], provider: 'moodle' },
    { flag: 'COMMUNITY_DRIVER', altFlag: 'DISCOURSE_DRIVER', creds: ['DISCOURSE_API_KEY'], provider: 'discourse' },
    { flag: 'CMS_DRIVER', altFlag: 'DIRECTUS_DRIVER', creds: ['DIRECTUS_TOKEN'], provider: 'directus' },
    { flag: 'SEARCH_DRIVER', altFlag: null, creds: ['MEILISEARCH_API_KEY'], provider: 'search' }
  ].map(({ flag, altFlag, creds, provider }) => ({
    name: `env:driver-${provider}`,
    problem: (env) => {
      const driver = env[flag] ?? (altFlag ? env[altFlag] : undefined);
      if (!driver || driver === 'stub') {
        return null;
      }
      return creds.some((name) => env[name])
        ? null
        : `${provider} driver '${driver}' enabled without credentials (expected one of: ${creds.join(', ')})`;
    }
  }))
];

export async function runVerifyDeployment(env = process.env, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? console.log;
  const results = [];
  const record = (name, status, detail) => {
    results.push({ name, status, detail });
    log(`${status} ${name} — ${detail}`);
  };

  // 1. Required environment.
  for (const check of envChecks) {
    const problem = check.problem(env);
    record(check.name, problem ? 'FAIL' : 'PASS', problem ?? 'present');
  }
  if (env.ALLOW_INMEMORY_PERSISTENCE === 'true' || env.ALLOW_INMEMORY_CACHE === 'true') {
    log('warning: break-glass in-memory flags are set — acceptable for drills, NOT for production traffic');
  }

  // 2. Migration level + datastore reachability (delegated to the provider harness).
  const providerResults = await (deps.runProviders ?? runChecks)(env, deps.providerDeps ?? {});
  for (const result of providerResults.filter((r) => r.name === 'postgres' || r.name === 'redis')) {
    const status = result.status === 'SKIP' && !env[result.name === 'postgres' ? 'DATABASE_URL' : 'REDIS_URL']
      ? (env.ALLOW_INMEMORY_PERSISTENCE === 'true' || env.ALLOW_INMEMORY_CACHE === 'true' ? 'SKIP' : 'FAIL')
      : result.status;
    record(`provider:${result.name}`, status, result.detail);
  }

  // 3. Readiness endpoint.
  const baseUrl = (env.API_BASE_URL ?? 'http://localhost:3001/api/v1').replace(/\/+$/, '');
  try {
    const res = await fetchFn(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      record('api:health-ready', 'PASS', `HTTP 200 (status=${body.status ?? 'unknown'})`);
    } else {
      record('api:health-ready', 'FAIL', `HTTP ${res.status} from ${baseUrl}/health/ready`);
    }
  } catch (error) {
    record('api:health-ready', 'FAIL', `${baseUrl}/health/ready unreachable: ${String(error.message).slice(0, 200)}`);
  }

  const ok = results.every((r) => r.status !== 'FAIL');
  log(ok ? '==> deployment verification PASSED' : '==> deployment verification FAILED');
  return { results, ok };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const { ok } = await runVerifyDeployment(process.env);
  process.exit(ok ? 0 : 1);
}
