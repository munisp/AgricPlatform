#!/usr/bin/env node
/**
 * PostgreSQL backup (Wave OPS). Timestamped pg_dump custom-format dump +
 * SHA-256 checksum + a manifest (exact per-table row counts) that
 * scripts/verify-restore.mjs uses for DR drills.
 *
 * Fails closed: any failed step (pg_dump, checksum, upload) exits non-zero
 * so schedulers alert. Never prints credentials.
 *
 * Environment:
 *   DATABASE_URL     (required) connection string — never logged
 *   BACKUP_DIR       output directory                 (default ./backups)
 *   RETENTION_DAYS   local pruning window, days       (default 14; 0 = keep)
 *   S3_BUCKET        optional s3://bucket[/prefix] off-site upload via aws CLI
 *   S3_ENDPOINT_URL  optional S3-compatible endpoint (Backblaze, MinIO)
 *
 * Output files in BACKUP_DIR:
 *   agric_platform_<UTC>.dump           pg_dump custom format
 *   agric_platform_<UTC>.dump.sha256    "<sha256>  <basename>"
 *   agric_platform_<UTC>.manifest.json  { createdAt, file, sha256, tables }
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Default command runner (promisified execFile, captures output, never shells out). */
function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function timestampUtc(date) {
  // 2025-01-02T03:04:05.000Z → 20250102T030405Z
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Exact per-table row counts, as one JSON line from psql (null when unavailable). */
const TABLE_COUNT_SQL =
  "SELECT json_agg(t ORDER BY t.table_name) FROM (" +
  "  SELECT table_name, (" +
  "    xpath('/row/c/text()', query_to_xml(" +
  "      format('SELECT count(*) AS c FROM %I', table_name), false, true, ''" +
  "    ))[1]::text::bigint" +
  "  ) AS rows" +
  "  FROM information_schema.tables" +
  "  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'" +
  ") t";

/**
 * Runs one backup. `deps` is the test seam: { run, now }.
 * Returns the backup descriptor; throws (fail-closed) on any step failure.
 */
export async function runBackup(env = process.env, deps = {}) {
  const run = deps.run ?? defaultRun;
  const now = deps.now ?? new Date();
  const log = deps.log ?? console.log;

  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required (never printed). Refusing to guess a database.');
  }
  const backupDir = env.BACKUP_DIR ?? './backups';
  const retentionDays = Number(env.RETENTION_DAYS ?? 14);
  const stamp = timestampUtc(now);
  const base = `agric_platform_${stamp}`;
  const dumpPath = path.join(backupDir, `${base}.dump`);

  await mkdir(backupDir, { recursive: true });

  log(`==> dumping database to ${dumpPath}`);
  const dump = await run('pg_dump', [
    `--dbname=${env.DATABASE_URL}`,
    '--format=custom',
    '--compress=6',
    '--no-owner',
    '--no-privileges',
    `--file=${dumpPath}`
  ]);
  if (dump.code !== 0) {
    throw new Error(`pg_dump failed (exit ${dump.code}): ${dump.stderr.slice(0, 300)}`);
  }

  log('==> computing SHA-256 checksum');
  const sha256 = await sha256File(dumpPath);
  await writeFile(`${dumpPath}.sha256`, `${sha256}  ${base}.dump\n`);
  log(`sha256: ${sha256}`);

  // Exact table counts for the DR-drill manifest. Skipped (with a warning)
  // when psql is unavailable — verify-restore then reports the gap honestly.
  let tables = null;
  const counts = await run('psql', [env.DATABASE_URL, '-At', '-v', 'ON_ERROR_STOP=1', '-c', TABLE_COUNT_SQL]);
  if (counts.code === 0) {
    try {
      tables = JSON.parse(counts.stdout.trim());
    } catch {
      tables = null;
    }
  }
  if (!tables) {
    log('warning: psql table-count snapshot unavailable; manifest written without row counts');
  }

  const manifest = {
    createdAt: now.toISOString(),
    file: `${base}.dump`,
    sha256,
    tables
  };
  const manifestPath = path.join(backupDir, `${base}.manifest.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (env.S3_BUCKET) {
    const target = env.S3_BUCKET.replace(/^s3:\/\//, '').replace(/\/+$/, '');
    const endpointArgs = env.S3_ENDPOINT_URL ? [`--endpoint-url=${env.S3_ENDPOINT_URL}`] : [];
    for (const file of [dumpPath, `${dumpPath}.sha256`, manifestPath]) {
      log(`==> uploading ${path.basename(file)} to s3://${target}/`);
      const up = await run('aws', [...endpointArgs, 's3', 'cp', file, `s3://${target}/${path.basename(file)}`]);
      if (up.code !== 0) {
        throw new Error(
          `S3 upload failed for ${path.basename(file)} (exit ${up.code}): ${up.stderr.slice(0, 300)}. ` +
            'The local backup exists, but the requested off-site copy does NOT — treating the backup as failed.'
        );
      }
    }
  }

  if (retentionDays > 0) {
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    for (const entry of await readdir(backupDir)) {
      if (!/^agric_platform_.*\.(dump|dump\.sha256|manifest\.json)$/.test(entry)) {
        continue;
      }
      const full = path.join(backupDir, entry);
      const info = await stat(full);
      if (info.mtimeMs < cutoff) {
        await unlink(full);
        log(`==> pruned ${entry} (older than ${retentionDays} days)`);
      }
    }
  }

  log(`==> backup complete: ${dumpPath}`);
  return { dumpPath, manifestPath, sha256, tables };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    await runBackup(process.env);
  } catch (error) {
    console.error(`backup-db: FAIL — ${error.message}`);
    process.exit(1);
  }
}
