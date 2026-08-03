#!/usr/bin/env node
/**
 * Provider verification harness (Wave OPS). Probes every external system the
 * platform depends on and reports one line per provider:
 *
 *   PASS <name> — <what was verified>
 *   FAIL <name> — <why>                      (exit code 1)
 *   SKIP <name> — <which env var is missing> (warning only, exit code stays 0)
 *
 * Exit code is 0 only when every CONFIGURED provider passes. SKIP means the
 * provider was never configured — acceptable for optional integrations, a
 * warning for required ones (see verify-deployment.mjs for the strict
 * production-gate version).
 *
 * SECURITY: this script never prints secret values. Error messages from
 * providers are truncated and have tokens redacted before display.
 *
 * Environment (all optional — unset means SKIP):
 *   DATABASE_URL          Postgres connection string (+ migration level check)
 *   REDIS_URL             Redis connection string (PING)
 *   OIDC_ISSUER           OIDC issuer URL (discovery document) + OIDC_AUDIENCE
 *   PAYSTACK_SECRET_KEY   Paystack secret key (GET /balance)
 *   TERMII_API_KEY        termii API key (GET balance)
 *   WEATHER_DRIVER        non-'stub' enables the weather feed check (Open-Meteo)
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'infra', 'postgres');

/** Redact anything that looks like a credential from an error string. */
export function redact(text) {
  return String(text)
    .replace(/sk_(live|test)_[A-Za-z0-9]+/g, 'sk_$1_…redacted')
    .replace(/api_key=[^&\s]+/gi, 'api_key=…redacted')
    .replace(/(postgres(?:ql)?|redis):\/\/[^@\s]+@/gi, '$1://…redacted@')
    .slice(0, 300);
}

export function listMigrationFiles(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((file) => /^\d+[a-z]?_.*\.sql$/.test(file))
    .sort();
}

const pass = (name, detail) => ({ name, status: 'PASS', detail });
const fail = (name, detail) => ({ name, status: 'FAIL', detail });
const skip = (name, detail) => ({ name, status: 'SKIP', detail });

async function checkPostgres(env, deps) {
  if (!env.DATABASE_URL) {
    return skip('postgres', 'DATABASE_URL not set');
  }
  const pg = deps.pg ?? (await import('pg')).default;
  const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
  } catch (error) {
    return fail('postgres', `connect failed: ${redact(error.message)}`);
  }
  try {
    let applied;
    try {
      const res = await client.query('SELECT filename FROM schema_migrations');
      applied = new Set(res.rows.map((row) => row.filename));
    } catch {
      return fail('postgres', 'connected, but schema_migrations is missing — run: npm run migrate -w @agric-platform/api');
    }
    const files = (deps.listMigrationFiles ?? listMigrationFiles)();
    const missing = files.filter((file) => !applied.has(file));
    if (missing.length > 0) {
      return fail('postgres', `migration level behind: ${missing.length} file(s) not applied (${missing[0]}…)`);
    }
    return pass('postgres', `connected; migration level current (${files.length} files applied)`);
  } catch (error) {
    return fail('postgres', redact(error.message));
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkRedis(env, deps) {
  if (!env.REDIS_URL) {
    return skip('redis', 'REDIS_URL not set');
  }
  const Redis = deps.redis ?? (await import('ioredis')).default;
  const client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null
  });
  try {
    await client.connect();
    const pong = await client.ping();
    return pong === 'PONG'
      ? pass('redis', 'PING → PONG')
      : fail('redis', `unexpected PING reply: ${redact(pong)}`);
  } catch (error) {
    return fail('redis', `connect/ping failed: ${redact(error.message)}`);
  } finally {
    client.disconnect();
  }
}

async function checkOidc(env, deps) {
  const issuer = env.OIDC_ISSUER ?? (env.KEYCLOAK_URL
    ? `${env.KEYCLOAK_URL.replace(/\/$/, '')}/realms/${env.KEYCLOAK_REALM ?? 'agric-platform'}`
    : undefined);
  if (!issuer) {
    return skip('oidc', 'OIDC_ISSUER (or KEYCLOAK_URL) not set');
  }
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const discoveryUrl = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  let doc;
  try {
    const res = await fetchFn(discoveryUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      return fail('oidc', `discovery document HTTP ${res.status} at ${new URL(discoveryUrl).host}`);
    }
    doc = await res.json();
  } catch (error) {
    return fail('oidc', `discovery document unreachable: ${redact(error.message)}`);
  }
  if (!doc.issuer || doc.issuer.replace(/\/$/, '') !== issuer.replace(/\/$/, '')) {
    return fail('oidc', `discovery issuer mismatch (got ${redact(doc.issuer ?? 'none')})`);
  }
  if (!doc.jwks_uri) {
    return fail('oidc', 'discovery document has no jwks_uri');
  }
  const audience = env.OIDC_AUDIENCE ?? env.KEYCLOAK_CLIENT_ID;
  if (!audience) {
    return fail('oidc', 'OIDC_AUDIENCE (or KEYCLOAK_CLIENT_ID) not set — production boot requires an audience');
  }
  return pass('oidc', `discovery reachable; issuer matches; audience configured (${audience})`);
}

async function checkPaystack(env, deps) {
  if (!env.PAYSTACK_SECRET_KEY) {
    return skip('paystack', 'PAYSTACK_SECRET_KEY not set');
  }
  const fetchFn = deps.fetch ?? globalThis.fetch;
  try {
    const res = await fetchFn('https://api.paystack.co/balance', {
      headers: { authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      return fail('paystack', `GET /balance → HTTP ${res.status} (key rejected or provider error)`);
    }
    return pass('paystack', 'GET /balance → 200 (secret key accepted)');
  } catch (error) {
    return fail('paystack', `GET /balance failed: ${redact(error.message)}`);
  }
}

async function checkTermii(env, deps) {
  if (!env.TERMII_API_KEY) {
    return skip('termii', 'TERMII_API_KEY not set');
  }
  const fetchFn = deps.fetch ?? globalThis.fetch;
  try {
    // NOTE: termii's API takes the key as a query parameter (their design);
    // the URL is never logged by this script.
    const res = await fetchFn(
      `https://api.ng.termii.com/api/get-balance?api_key=${encodeURIComponent(env.TERMII_API_KEY)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) {
      return fail('termii', `GET balance → HTTP ${res.status}`);
    }
    const body = await res.json().catch(() => ({}));
    return pass('termii', `GET balance → 200 (balance: ${redact(body.balance ?? 'n/a')})`);
  } catch (error) {
    return fail('termii', `GET balance failed: ${redact(error.message)}`);
  }
}

async function checkWeather(env, deps) {
  const driver = env.WEATHER_DRIVER ?? env.WEATHER_FEED_DRIVER;
  if (!driver || driver === 'stub') {
    return skip('weather', 'WEATHER_DRIVER not set (stub fixtures in use)');
  }
  if (driver === 'nimet') {
    return skip('weather', 'NiMet feed is MoU-gated — verify the feed manually with the vendor');
  }
  const fetchFn = deps.fetch ?? globalThis.fetch;
  try {
    // Abuja coordinates; smallest possible Open-Meteo request.
    const res = await fetchFn(
      'https://api.open-meteo.com/v1/forecast?latitude=9.0765&longitude=7.3986&current=temperature_2m',
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) {
      return fail('weather', `Open-Meteo → HTTP ${res.status}`);
    }
    const body = await res.json().catch(() => ({}));
    return body.current
      ? pass('weather', 'Open-Meteo current conditions reachable')
      : fail('weather', 'Open-Meteo responded without a current block');
  } catch (error) {
    return fail('weather', `Open-Meteo unreachable: ${redact(error.message)}`);
  }
}

/**
 * Runs all provider checks. `deps` is the test seam: inject { pg, redis,
 * fetch, listMigrationFiles } fakes to exercise pass/fail/skip paths without
 * real network or databases.
 */
export async function runChecks(env = process.env, deps = {}) {
  // Sequential: the output order is stable for humans and CI logs.
  const results = [];
  results.push(await checkPostgres(env, deps));
  results.push(await checkRedis(env, deps));
  results.push(await checkOidc(env, deps));
  results.push(await checkPaystack(env, deps));
  results.push(await checkTermii(env, deps));
  results.push(await checkWeather(env, deps));
  return results;
}

export function formatResults(results) {
  return results.map((r) => `${r.status} ${r.name} — ${r.detail}`);
}

export function exitCodeFor(results) {
  return results.some((r) => r.status === 'FAIL') ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const results = await runChecks(process.env);
  for (const line of formatResults(results)) {
    console.log(line);
  }
  const skipped = results.filter((r) => r.status === 'SKIP');
  if (skipped.length > 0) {
    console.warn(`warning: ${skipped.length} provider(s) skipped (not configured)`);
  }
  process.exit(exitCodeFor(results));
}
