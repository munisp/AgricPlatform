import { describe, expect, it } from 'vitest';
import {
  exitCodeFor,
  formatResults,
  redact,
  runChecks
} from '../../../../scripts/verify-providers.mjs';

/** Fake pg module: connect throws when `connectError`, else serves `files`. */
function fakePg(options: { files?: string[]; connectError?: string; noMigrationsTable?: boolean }) {
  return {
    Client: class {
      async connect(): Promise<void> {
        if (options.connectError) {
          throw new Error(options.connectError);
        }
      }
      async query(sql: string): Promise<{ rows: { filename: string }[] }> {
        if (options.noMigrationsTable || !sql.includes('schema_migrations')) {
          throw new Error('relation "schema_migrations" does not exist');
        }
        return { rows: (options.files ?? []).map((filename) => ({ filename })) };
      }
      async end(): Promise<void> {}
    }
  };
}

function fakeRedis(options: { pong?: string; connectError?: string }) {
  return class {
    async connect(): Promise<void> {
      if (options.connectError) {
        throw new Error(options.connectError);
      }
    }
    async ping(): Promise<string> {
      return options.pong ?? 'PONG';
    }
    disconnect(): void {}
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const MIGRATIONS = ['001_init.sql', '002_audit_hash_chain.sql'];
const listMigrationFiles = () => MIGRATIONS;

describe('redact', () => {
  it('strips credentials from connection strings and provider keys', () => {
    expect(redact('connect postgres://user:secretpw@db.internal:5432/agric')).not.toContain('secretpw');
    expect(redact('auth failed for sk_live_abcdef123456')).not.toContain('abcdef123456');
    expect(redact('GET /api/get-balance?api_key=TLsecretkey 401')).not.toContain('TLsecretkey');
  });
});

describe('verify-providers runChecks', () => {
  it('SKIPs everything when nothing is configured (exit code stays 0)', async () => {
    const results = await runChecks({}, { listMigrationFiles });
    expect(results.every((r) => r.status === 'SKIP')).toBe(true);
    expect(exitCodeFor(results)).toBe(0);
  });

  it('PASSes postgres when connected and migration level is current', async () => {
    const results = await runChecks(
      { DATABASE_URL: 'postgres://u:p@h/db' },
      { pg: fakePg({ files: MIGRATIONS }), listMigrationFiles }
    );
    expect(results[0]).toMatchObject({ name: 'postgres', status: 'PASS' });
  });

  it('FAILs postgres when migrations are behind the repo files', async () => {
    const results = await runChecks(
      { DATABASE_URL: 'postgres://u:p@h/db' },
      { pg: fakePg({ files: ['001_init.sql'] }), listMigrationFiles }
    );
    expect(results[0].status).toBe('FAIL');
    expect(results[0].detail).toContain('002_audit_hash_chain.sql');
    expect(exitCodeFor(results)).toBe(1);
  });

  it('FAILs postgres on connection error and redacts the connection string', async () => {
    const results = await runChecks(
      { DATABASE_URL: 'postgres://u:supersecret@h/db' },
      { pg: fakePg({ connectError: 'could not connect to postgres://u:supersecret@h/db' }), listMigrationFiles }
    );
    expect(results[0].status).toBe('FAIL');
    expect(JSON.stringify(results)).not.toContain('supersecret');
  });

  it('FAILs postgres when schema_migrations is missing', async () => {
    const results = await runChecks(
      { DATABASE_URL: 'postgres://u:p@h/db' },
      { pg: fakePg({ noMigrationsTable: true }), listMigrationFiles }
    );
    expect(results[0]).toMatchObject({ name: 'postgres', status: 'FAIL' });
    expect(results[0].detail).toContain('migrate');
  });

  it('PASSes/FAILs redis on PING result', async () => {
    const ok = await runChecks({ REDIS_URL: 'redis://h' }, { redis: fakeRedis({}), listMigrationFiles });
    expect(ok[1]).toMatchObject({ name: 'redis', status: 'PASS' });
    const down = await runChecks(
      { REDIS_URL: 'redis://h' },
      { redis: fakeRedis({ connectError: 'ECONNREFUSED' }), listMigrationFiles }
    );
    expect(down[1].status).toBe('FAIL');
  });

  it('PASSes OIDC when discovery matches issuer and audience is configured', async () => {
    const fetch = async () =>
      jsonResponse(200, { issuer: 'https://idp.example/realms/agric', jwks_uri: 'https://idp.example/jwks' }) as Response;
    const results = await runChecks(
      { OIDC_ISSUER: 'https://idp.example/realms/agric', OIDC_AUDIENCE: 'agric-api' },
      { fetch, listMigrationFiles }
    );
    expect(results[2]).toMatchObject({ name: 'oidc', status: 'PASS' });
  });

  it('FAILs OIDC on issuer mismatch, unreachable discovery, or missing audience', async () => {
    const mismatch = await runChecks(
      { OIDC_ISSUER: 'https://idp.example/realms/agric', OIDC_AUDIENCE: 'agric-api' },
      {
        fetch: async () => jsonResponse(200, { issuer: 'https://evil.example', jwks_uri: 'x' }) as Response,
        listMigrationFiles
      }
    );
    expect(mismatch[2].status).toBe('FAIL');

    const unreachable = await runChecks(
      { OIDC_ISSUER: 'https://idp.example/realms/agric', OIDC_AUDIENCE: 'agric-api' },
      { fetch: async () => jsonResponse(503, {}) as Response, listMigrationFiles }
    );
    expect(unreachable[2].status).toBe('FAIL');

    const goodFetch = async () =>
      jsonResponse(200, { issuer: 'https://idp.example/realms/agric', jwks_uri: 'x' }) as Response;
    const noAudience = await runChecks(
      { OIDC_ISSUER: 'https://idp.example/realms/agric' },
      { fetch: goodFetch, listMigrationFiles }
    );
    expect(noAudience[2].status).toBe('FAIL');
    expect(noAudience[2].detail).toContain('OIDC_AUDIENCE');
  });

  it('PASSes paystack on HTTP 200 and never prints the secret key', async () => {
    const key = 'sk_test_supersecretvalue';
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.paystack.co/balance');
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`);
      return jsonResponse(200, { status: true }) as Response;
    };
    const results = await runChecks({ PAYSTACK_SECRET_KEY: key }, { fetch, listMigrationFiles });
    expect(results[3]).toMatchObject({ name: 'paystack', status: 'PASS' });
    expect(formatResults(results).join('\n')).not.toContain(key);
  });

  it('FAILs paystack on HTTP 401', async () => {
    const results = await runChecks(
      { PAYSTACK_SECRET_KEY: 'sk_test_x' },
      { fetch: async () => jsonResponse(401, {}) as Response, listMigrationFiles }
    );
    expect(results[3].status).toBe('FAIL');
  });

  it('PASSes termii on HTTP 200 and never leaks the api_key', async () => {
    const results = await runChecks(
      { TERMII_API_KEY: 'TLmysecretkey' },
      { fetch: async () => jsonResponse(200, { balance: 42 }) as Response, listMigrationFiles }
    );
    expect(results[4]).toMatchObject({ name: 'termii', status: 'PASS' });
    expect(JSON.stringify(results)).not.toContain('TLmysecretkey');
  });

  it('checks the weather feed only when a non-stub driver is configured', async () => {
    const skipped = await runChecks({ WEATHER_DRIVER: 'stub' }, { listMigrationFiles });
    expect(skipped[5].status).toBe('SKIP');

    const ok = await runChecks(
      { WEATHER_DRIVER: 'open-meteo' },
      { fetch: async () => jsonResponse(200, { current: { temperature_2m: 31 } }) as Response, listMigrationFiles }
    );
    expect(ok[5]).toMatchObject({ name: 'weather', status: 'PASS' });

    const broken = await runChecks(
      { WEATHER_DRIVER: 'open-meteo' },
      { fetch: async () => jsonResponse(502, {}) as Response, listMigrationFiles }
    );
    expect(broken[5].status).toBe('FAIL');
  });
});
