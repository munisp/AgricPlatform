#!/usr/bin/env node
/**
 * Restore verification / DR drill (Wave OPS). Proves a backup actually
 * restores: picks the latest backup in BACKUP_DIR (or BACKUP_FILE
 * explicitly), verifies its SHA-256 checksum, restores it into a throwaway
 * scratch database, validates per-table row counts against the backup
 * manifest, then drops the scratch database.
 *
 * Exit 0 only when every check passes. The scratch database is dropped even
 * on failure (best effort). Never prints credentials.
 *
 * Environment:
 *   DATABASE_URL    (required) ADMIN connection string for the server that
 *                   hosts the scratch database (any maintenance db works).
 *                   Never the production URL of a database you care about —
 *                   the drill creates and drops SCRATCH_DATABASE on it.
 *   BACKUP_DIR      directory with agric_platform_*.dump + manifest
 *                   (default ./backups)
 *   BACKUP_FILE     explicit dump path instead of "latest in BACKUP_DIR"
 *   SCRATCH_DATABASE  scratch db name (default agric_restore_drill)
 *   KEEP_SCRATCH=1  keep the scratch database afterwards (debugging)
 */

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256File } from './backup-db.mjs';

function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Latest agric_platform_*.manifest.json in a directory (lexical = chronological). */
export async function findLatestBackup(backupDir) {
  const manifests = (await readdir(backupDir))
    .filter((file) => /^agric_platform_.*\.manifest\.json$/.test(file))
    .sort();
  if (manifests.length === 0) {
    return null;
  }
  const manifestPath = path.join(backupDir, manifests[manifests.length - 1]);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  return { manifest, manifestPath, dumpPath: path.join(backupDir, manifest.file) };
}

function adminUrl(env, scratchDatabase) {
  // Point the admin URL at the scratch database for restore/count steps.
  const url = new URL(env.DATABASE_URL);
  url.pathname = `/${scratchDatabase}`;
  return url.toString();
}

function maintenanceUrl(env) {
  const url = new URL(env.DATABASE_URL);
  url.pathname = '/postgres';
  return url.toString();
}

/**
 * Runs the drill. `deps` is the test seam: { run }.
 * Returns { checks: [{name, status, detail}], ok } — never throws on a
 * failed check; throws only on misuse (missing env / no backup found).
 */
export async function runVerifyRestore(env = process.env, deps = {}) {
  const run = deps.run ?? defaultRun;
  const log = deps.log ?? console.log;

  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL (admin connection for the scratch server) is required.');
  }
  const backupDir = env.BACKUP_DIR ?? './backups';
  const scratch = env.SCRATCH_DATABASE ?? 'agric_restore_drill';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(scratch)) {
    throw new Error(`SCRATCH_DATABASE "${scratch}" is not a safe identifier.`);
  }

  let dumpPath = env.BACKUP_FILE;
  let manifest = null;
  if (dumpPath) {
    const manifestPath = `${dumpPath.replace(/\.dump$/, '')}.manifest.json`;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      log(`warning: no manifest at ${manifestPath}; table-count validation will be skipped`);
    }
  } else {
    const latest = await findLatestBackup(backupDir);
    if (!latest) {
      throw new Error(`no agric_platform_*.manifest.json found in ${backupDir} — run backup:db first.`);
    }
    ({ manifest, dumpPath } = latest);
  }

  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, status: ok ? 'PASS' : 'FAIL', detail });
    log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
    return ok;
  };

  // 1. Checksum.
  if (manifest?.sha256) {
    const actual = await sha256File(dumpPath);
    check('checksum', actual === manifest.sha256,
      actual === manifest.sha256 ? `sha256 matches manifest (${actual.slice(0, 12)}…)` : `sha256 MISMATCH: manifest ${manifest.sha256.slice(0, 12)}… vs file ${actual.slice(0, 12)}…`);
  } else {
    checks.push({ name: 'checksum', status: 'SKIP', detail: 'manifest has no sha256' });
  }

  const maintenance = maintenanceUrl(env);
  const scratchUrl = adminUrl(env, scratch);

  // 2. Fresh scratch database.
  await run('psql', [maintenance, '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE IF EXISTS ${scratch}`]);
  const created = await run('psql', [maintenance, '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${scratch}`]);
  if (!check('scratch-create', created.code === 0, created.code === 0 ? `created ${scratch}` : created.stderr.slice(0, 300))) {
    return { checks, ok: false };
  }

  try {
    // 3. Restore.
    const restored = await run('pg_restore', [
      `--dbname=${scratchUrl}`,
      '--no-owner',
      '--no-privileges',
      dumpPath
    ]);
    // pg_restore returns non-zero on warnings too; treat only a missing schema as fatal below.
    check('restore', restored.code === 0,
      restored.code === 0 ? 'pg_restore completed' : `pg_restore exit ${restored.code}: ${restored.stderr.slice(0, 300)}`);

    // 4. Table-count validation against the manifest.
    if (Array.isArray(manifest?.tables)) {
      for (const table of manifest.tables) {
        const counted = await run('psql', [
          scratchUrl, '-At', '-v', 'ON_ERROR_STOP=1',
          '-c', `SELECT count(*) FROM "${table.table_name}"`
        ]);
        const actual = counted.code === 0 ? counted.stdout.trim() : null;
        check(
          `table:${table.table_name}`,
          actual !== null && actual === String(table.rows),
          actual === null
            ? `count query failed: ${counted.stderr.slice(0, 200)}`
            : `manifest=${table.rows} restored=${actual}`
        );
      }
    } else {
      checks.push({ name: 'table-counts', status: 'SKIP', detail: 'manifest has no table counts' });
      log('SKIP table-counts — manifest has no table counts');
    }
  } finally {
    if (env.KEEP_SCRATCH !== '1') {
      const dropped = await run('psql', [maintenance, '-c', `DROP DATABASE IF EXISTS ${scratch}`]);
      log(dropped.code === 0 ? `==> scratch database ${scratch} dropped` : `warning: could not drop ${scratch}: ${dropped.stderr.slice(0, 200)}`);
    } else {
      log(`==> KEEP_SCRATCH=1 — scratch database ${scratch} left in place`);
    }
  }

  const ok = checks.every((c) => c.status !== 'FAIL');
  log(ok ? '==> restore drill PASSED' : '==> restore drill FAILED');
  return { checks, ok };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    const { ok } = await runVerifyRestore(process.env);
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(`verify-restore: FAIL — ${error.message}`);
    process.exit(1);
  }
}
