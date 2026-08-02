#!/usr/bin/env node
/**
 * Media audit (Wave P3 NFR tooling).
 *
 * Scans apps/web for media performance regressions and exits non-zero on
 * findings:
 *
 *   1. <img> elements in TSX/JSX sources without loading="lazy". Next.js
 *      <Image> lazy-loads by default and is ignored; raw <img> tags are the
 *      risk. Above-the-fold exceptions (logos, heroes) can be suppressed —
 *      see below.
 *   2. Raster assets (png/jpg/jpeg/gif/bmp) in apps/web/public — new raster
 *      assets should ship as WebP (or AVIF). Small unavoidable assets can be
 *      suppressed.
 *
 * Suppressions (documented, grep-able):
 *   - JSX: put `media-audit-ignore` in a comment on the line above the <img>
 *     tag or on the same line, e.g.
 *       {// media-audit-ignore: LCP hero, eager on purpose}
 *   - Assets: list the public/-relative path in SUPPRESSED_ASSETS below with
 *     a reason comment.
 *
 * Usage: node scripts/audit-media.mjs [--dir apps/web] [--help]
 * Wired as `npm run audit:media`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Suppressed raster assets (public/-relative paths) with reasons:
 * (none currently — add entries like:)
 * 'favicon-32.png': 'browser favicon requires PNG',
 */
const SUPPRESSED_ASSETS = new Set([]);

const RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp']);
const SOURCE_EXTENSIONS = new Set(['.tsx', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', '.git']);

function parseArgs(argv) {
  const args = { dir: 'apps/web' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--dir') args.dir = argv[++i];
    else {
      console.error(`audit:media — unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'audit:media — fail on <img> without loading="lazy" and non-WebP raster assets in public/\n' +
        'Usage: node scripts/audit-media.mjs [--dir apps/web] [--help]'
    );
    return;
  }

  const webDir = join(repoRoot, args.dir);
  if (!existsSync(webDir)) {
    console.error(`audit:media — directory not found: ${webDir}`);
    process.exit(2);
  }

  const findings = [];

  for (const file of walk(webDir)) {
    const ext = extname(file).toLowerCase();
    const rel = relative(webDir, file);

    // Check 2: non-WebP raster assets under public/.
    if (rel.startsWith('public') && RASTER_EXTENSIONS.has(ext)) {
      if (!SUPPRESSED_ASSETS.has(rel)) {
        findings.push(`${rel}: raster asset in public/ — ship WebP/AVIF (or add a SUPPRESSED_ASSETS entry)`);
      }
      continue;
    }

    // Check 1: raw <img> without loading="lazy" in JSX sources.
    if (SOURCE_EXTENSIONS.has(ext)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!/<img[\s>]/.test(line)) return;
        if (/loading\s*=/.test(line)) return;
        const previous = index > 0 ? lines[index - 1] : '';
        if (line.includes('media-audit-ignore') || previous.includes('media-audit-ignore')) return;
        findings.push(
          `${rel}:${index + 1}: <img> without loading="lazy" — add the attribute or a media-audit-ignore comment`
        );
      });
    }
  }

  if (findings.length > 0) {
    console.error(`audit:media FAILED — ${findings.length} finding(s):`);
    for (const finding of findings) console.error(`  ${finding}`);
    process.exit(1);
  }
  console.log('audit:media OK — no unlazy <img> tags or non-WebP public raster assets');
}

main();
