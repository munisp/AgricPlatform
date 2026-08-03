import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBackup, sha256File } from '../../../../scripts/backup-db.mjs';
import { findLatestBackup, runVerifyRestore } from '../../../../scripts/verify-restore.mjs';

type RunResult = { code: number; stdout: string; stderr: string };
type Run = (cmd: string, args: string[]) => Promise<RunResult>;

const NOW = new Date('2025-06-01T12:00:00.000Z');

/** Fake command runner: pg_dump writes the dump file; psql serves canned SQL replies. */
function fakeRun(options: {
  dumpContent?: string;
  dumpExit?: number;
  tableCountSql?: string;
  counts?: Record<string, number>;
  psqlExit?: number;
  restoreExit?: number;
  awsExit?: number;
  calls?: string[];
}): Run {
  const calls = options.calls ?? [];
  return async (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'pg_dump') {
      if ((options.dumpExit ?? 0) !== 0) {
        return { code: options.dumpExit ?? 1, stdout: '', stderr: 'pg_dump: connection failed' };
      }
      const file = args.find((a) => a.startsWith('--file='))?.slice('--file='.length);
      await writeFile(String(file), options.dumpContent ?? 'PGDMP-fake-contents');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'psql') {
      if ((options.psqlExit ?? 0) !== 0) {
        return { code: options.psqlExit ?? 1, stdout: '', stderr: 'psql error' };
      }
      const sql = args[args.indexOf('-c') + 1] ?? '';
      if (sql.startsWith('SELECT json_agg')) {
        return { code: 0, stdout: `${options.tableCountSql ?? '[]'}\n`, stderr: '' };
      }
      if (sql.startsWith('SELECT count(*)')) {
        const table = /FROM "([^"]+)"/.exec(sql)?.[1] ?? '';
        const rows = options.counts?.[table];
        return rows === undefined
          ? { code: 1, stdout: '', stderr: `relation "${table}" does not exist` }
          : { code: 0, stdout: `${rows}\n`, stderr: '' };
      }
      // CREATE/DROP DATABASE.
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'pg_restore') {
      return { code: options.restoreExit ?? 0, stdout: '', stderr: '' };
    }
    if (cmd === 'aws') {
      return { code: options.awsExit ?? 0, stdout: '', stderr: options.awsExit ? 'aws: access denied' : '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected command ${cmd}` };
  };
}

describe('backup-db.mjs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'backup-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses to run without DATABASE_URL (fail closed)', async () => {
    await expect(runBackup({ BACKUP_DIR: dir }, { now: NOW })).rejects.toThrow('DATABASE_URL');
  });

  it('writes dump, checksum file and manifest with table counts', async () => {
    const tables = [
      { table_name: 'users', rows: 10 },
      { table_name: 'orders', rows: 3 }
    ];
    const result = await runBackup(
      { DATABASE_URL: 'postgres://u:p@h/db', BACKUP_DIR: dir },
      { run: fakeRun({ tableCountSql: JSON.stringify(tables) }), now: NOW }
    );

    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.tables).toEqual(tables);

    const checksumLine = await readFile(`${result.dumpPath}.sha256`, 'utf8');
    expect(checksumLine).toContain(result.sha256);
    expect(await sha256File(result.dumpPath)).toBe(result.sha256);

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.file).toBe('agric_platform_20250601T120000Z.dump');
    expect(manifest.tables).toEqual(tables);
  });

  it('propagates pg_dump failure (exit non-zero, no manifest written)', async () => {
    await expect(
      runBackup(
        { DATABASE_URL: 'postgres://u:p@h/db', BACKUP_DIR: dir },
        { run: fakeRun({ dumpExit: 1 }), now: NOW }
      )
    ).rejects.toThrow('pg_dump failed');
    await expect(findLatestBackup(dir)).resolves.toBeNull();
  });

  it('uploads dump, checksum and manifest to S3 when S3_BUCKET is set', async () => {
    const calls: string[] = [];
    await runBackup(
      { DATABASE_URL: 'postgres://u:p@h/db', BACKUP_DIR: dir, S3_BUCKET: 's3://dr-backups/agric' },
      { run: fakeRun({ calls }), now: NOW }
    );
    const uploads = calls.filter((c) => c.startsWith('aws s3 cp'));
    expect(uploads).toHaveLength(3);
    expect(uploads.every((c) => c.includes('s3://dr-backups/agric/'))).toBe(true);
  });

  it('treats a failed S3 upload as a failed backup (fail closed)', async () => {
    await expect(
      runBackup(
        { DATABASE_URL: 'postgres://u:p@h/db', BACKUP_DIR: dir, S3_BUCKET: 'bucket' },
        { run: fakeRun({ awsExit: 3 }), now: NOW }
      )
    ).rejects.toThrow('S3 upload failed');
  });

  it('prunes backups older than RETENTION_DAYS', async () => {
    const oldDump = path.join(dir, 'agric_platform_20200101T000000Z.dump');
    await writeFile(oldDump, 'old');
    // 30 days before the injected backup time (the script compares against it).
    const ancient = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    await utimes(oldDump, ancient, ancient);

    await runBackup(
      { DATABASE_URL: 'postgres://u:p@h/db', BACKUP_DIR: dir, RETENTION_DAYS: '14' },
      { run: fakeRun({}), now: NOW }
    );
    await expect(readFile(oldDump, 'utf8')).rejects.toThrow();
  });
});

describe('verify-restore.mjs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'restore-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Creates a real backup on disk via the (faked) backup script. */
  async function makeBackup(tables: { table_name: string; rows: number }[]) {
    return runBackup(
      { DATABASE_URL: 'postgres://u:p@h/db', BACKUP_DIR: dir },
      { run: fakeRun({ tableCountSql: JSON.stringify(tables) }), now: NOW, log: () => {} }
    );
  }

  it('requires DATABASE_URL', async () => {
    await expect(runVerifyRestore({}, { run: fakeRun({}), log: () => {} })).rejects.toThrow('DATABASE_URL');
  });

  it('fails honestly when no backup exists', async () => {
    await expect(
      runVerifyRestore({ DATABASE_URL: 'postgres://u:p@h/db', BACKUP_DIR: dir }, { run: fakeRun({}), log: () => {} })
    ).rejects.toThrow('no agric_platform_');
  });

  it('passes the drill when checksum and table counts match, and drops the scratch db', async () => {
    const tables = [{ table_name: 'users', rows: 10 }];
    await makeBackup(tables);
    const calls: string[] = [];
    const { ok, checks } = await runVerifyRestore(
      { DATABASE_URL: 'postgres://admin:pw@h/postgres', BACKUP_DIR: dir },
      { run: fakeRun({ counts: { users: 10 }, calls }), log: () => {} }
    );
    expect(ok).toBe(true);
    expect(checks.find((c) => c.name === 'checksum')?.status).toBe('PASS');
    expect(checks.find((c) => c.name === 'table:users')?.status).toBe('PASS');
    // Scratch lifecycle used the maintenance database, restore used the scratch db.
    expect(calls.some((c) => c.includes('CREATE DATABASE agric_restore_drill'))).toBe(true);
    expect(calls.some((c) => c.includes('DROP DATABASE IF EXISTS agric_restore_drill'))).toBe(true);
    expect(calls.some((c) => c.startsWith('pg_restore') && c.includes('/agric_restore_drill'))).toBe(true);
  });

  it('fails the drill on a table-count mismatch', async () => {
    await makeBackup([{ table_name: 'users', rows: 10 }]);
    const { ok, checks } = await runVerifyRestore(
      { DATABASE_URL: 'postgres://admin:pw@h/postgres', BACKUP_DIR: dir },
      { run: fakeRun({ counts: { users: 7 } }), log: () => {} }
    );
    expect(ok).toBe(false);
    expect(checks.find((c) => c.name === 'table:users')).toMatchObject({ status: 'FAIL' });
  });

  it('fails the drill on a checksum mismatch (corrupted dump)', async () => {
    const { dumpPath } = await makeBackup([{ table_name: 'users', rows: 1 }]);
    await writeFile(dumpPath, 'tampered-contents');
    const { ok, checks } = await runVerifyRestore(
      { DATABASE_URL: 'postgres://admin:pw@h/postgres', BACKUP_DIR: dir },
      { run: fakeRun({ counts: { users: 1 } }), log: () => {} }
    );
    expect(ok).toBe(false);
    expect(checks.find((c) => c.name === 'checksum')?.status).toBe('FAIL');
  });

  it('still drops the scratch database when the drill fails', async () => {
    await makeBackup([{ table_name: 'users', rows: 10 }]);
    const calls: string[] = [];
    await runVerifyRestore(
      { DATABASE_URL: 'postgres://admin:pw@h/postgres', BACKUP_DIR: dir },
      { run: fakeRun({ counts: { users: 1 }, calls }), log: () => {} }
    );
    expect(calls.some((c) => c.includes('DROP DATABASE IF EXISTS agric_restore_drill'))).toBe(true);
  });
});
