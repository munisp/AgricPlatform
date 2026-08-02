#!/usr/bin/env node
/**
 * Bundle budget gate (Wave P3 NFR tooling).
 *
 * Fails CI when the estimated initial JS for the app shell route exceeds the
 * budget (default 250 KB gzip).
 *
 * Estimate method (documented, deterministic):
 *   1. Initial JS file list for the shell route, resolved in order:
 *      a. apps/web/.next/app-build-manifest.json (App Router, webpack builds)
 *         plus rootMainFiles from build-manifest.json;
 *      b. build-manifest.json pages[route] (Pages Router) plus rootMainFiles;
 *      c. Next 16/Turbopack fallback: the <script src> tags of the
 *         prerendered route HTML (server/app/<route>.html) — this is exactly
 *         the set of JS files the browser executes on first load.
 *   2. Each unique .js file is gzipped INDIVIDUALLY with zlib.gzipSync
 *      (level 9) and the sizes are summed. Per-file gzip slightly
 *      overestimates vs. a single concatenated stream, which is the safe
 *      direction for a budget gate.
 *
 * Usage:
 *   node scripts/check-bundle-budget.mjs [--dir apps/web] [--route /]
 *                                        [--budget-kb 250] [--help]
 * Env overrides: BUNDLE_BUDGET_KB, BUNDLE_SHELL_ROUTE.
 * Wired as `npm run check:bundle` and invoked in CI after the web build.
 */
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { dir: 'apps/web', route: process.env.BUNDLE_SHELL_ROUTE || '/', budgetKb: Number(process.env.BUNDLE_BUDGET_KB || 250) };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--dir') args.dir = argv[++i];
    else if (arg === '--route') args.route = argv[++i];
    else if (arg === '--budget-kb') args.budgetKb = Number(argv[++i]);
    else {
      console.error(`check:bundle — unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

const HELP = `check:bundle — initial-JS bundle budget gate

Usage: node scripts/check-bundle-budget.mjs [options]

Options:
  --dir <path>       web app directory (default: apps/web)
  --route <route>    shell route to budget (default: / or BUNDLE_SHELL_ROUTE)
  --budget-kb <kb>   gzip budget in KB (default: 250 or BUNDLE_BUDGET_KB)
  -h, --help         show this help

Exit codes: 0 within budget, 1 budget exceeded, 2 usage/build-output error.`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!Number.isFinite(args.budgetKb) || args.budgetKb <= 0) {
    console.error(`check:bundle — invalid budget: ${args.budgetKb}`);
    process.exit(2);
  }

  const nextDir = join(repoRoot, args.dir, '.next');
  const appManifestPath = join(nextDir, 'app-build-manifest.json');
  const pagesManifestPath = join(nextDir, 'build-manifest.json');

  /** @type {Set<string>} */
  const files = new Set();
  let source = '';

  if (existsSync(appManifestPath)) {
    const manifest = JSON.parse(readFileSync(appManifestPath, 'utf8'));
    const routeFiles = manifest.pages?.[args.route];
    if (!routeFiles) {
      console.error(
        `check:bundle — route ${args.route} not found in app-build-manifest.json ` +
          `(known: ${Object.keys(manifest.pages ?? {}).join(', ') || 'none'})`
      );
      process.exit(2);
    }
    for (const file of routeFiles) files.add(file);
    source = 'app-build-manifest.json';
  } else if (existsSync(pagesManifestPath)) {
    const manifest = JSON.parse(readFileSync(pagesManifestPath, 'utf8'));
    const routeFiles = manifest.pages?.[args.route];
    if (routeFiles) {
      for (const file of routeFiles) files.add(file);
      source = 'build-manifest.json';
    }
  }

  // Framework/main chunks ship on every route; include them when present.
  if (source && existsSync(pagesManifestPath)) {
    const manifest = JSON.parse(readFileSync(pagesManifestPath, 'utf8'));
    for (const file of manifest.rootMainFiles ?? []) files.add(file);
  }

  if (!source) {
    // Next 16/Turbopack builds no longer emit per-route client manifests;
    // read the initial JS straight from the prerendered route HTML.
    const htmlName = args.route === '/' ? 'index.html' : `${args.route.replace(/^\//, '')}.html`;
    const htmlPath = join(nextDir, 'server', 'app', htmlName);
    if (!existsSync(htmlPath)) {
      console.error(
        `check:bundle — no route manifest and no prerendered HTML at ${htmlPath}. ` +
          'Run `npm run build -w apps/web` first (dynamic routes need a manifest).'
      );
      process.exit(2);
    }
    const html = readFileSync(htmlPath, 'utf8');
    for (const match of html.matchAll(/<script[^>]+src="\/_next\/([^"]+\.js)"/g)) {
      files.add(match[1]);
    }
    source = `prerendered HTML (${htmlName})`;
  }

  const jsFiles = [...files].filter((file) => file.endsWith('.js')).sort();
  if (jsFiles.length === 0) {
    console.error(`check:bundle — manifest lists no JS files for route ${args.route}`);
    process.exit(2);
  }

  let totalGzip = 0;
  const rows = [];
  for (const file of jsFiles) {
    const path = join(nextDir, file);
    if (!existsSync(path)) {
      console.error(`check:bundle — manifest file missing on disk: ${file}`);
      process.exit(2);
    }
    const raw = readFileSync(path);
    const gzip = gzipSync(raw, { level: 9 }).length;
    totalGzip += gzip;
    rows.push({ file, bytes: raw.length, gzip });
  }

  const budgetBytes = args.budgetKb * 1024;
  const kb = (n) => (n / 1024).toFixed(1);
  console.log(
    `check:bundle — route ${args.route} via ${source}: ${jsFiles.length} JS file(s), ` +
      `${kb(totalGzip)} KB gzip-estimated (budget ${args.budgetKb} KB)`
  );
  for (const row of rows.sort((a, b) => b.gzip - a.gzip).slice(0, 10)) {
    console.log(`  ${kb(row.gzip).padStart(8)} KB  ${row.file}`);
  }

  if (totalGzip > budgetBytes) {
    console.error(
      `check:bundle FAILED — initial JS for ${args.route} is ${kb(totalGzip)} KB gzip, ` +
        `over the ${args.budgetKb} KB budget.`
    );
    process.exit(1);
  }
  console.log('check:bundle OK');
}

main();
