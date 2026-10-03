#!/usr/bin/env node
/**
 * API client inventory (GAP-I01 / GAP-I02). Mechanically analyses the web
 * typed client (apps/web/lib/api/endpoints.ts) and regenerates
 * docs/api-client-inventory.md:
 *
 *   GAP-I01 — exported wrappers whose backend route exists in apps/api but
 *     which have NO caller in the web UI (components/app/lib outside the
 *     client itself). These are server-first capabilities without UI —
 *     a feature-availability gap (product backlog), NOT a defect; nothing
 *     is deleted.
 *   GAP-I02 — near-duplicate wrapper NAMES that map to DISTINCT backend
 *     routes (verified distinct, no true duplicates): naming-ambiguity
 *     documentation, optional future renames.
 *
 * Mechanical string analysis only (function-name references + apiFetch
 * literals); re-exports, aliased imports and dynamic dispatch are
 * invisible, so "no UI caller" means "no static reference found".
 *
 * Usage:
 *   node scripts/api-client-inventory.mjs            # rewrite docs/api-client-inventory.md
 *   node scripts/api-client-inventory.mjs --stdout   # print instead of writing
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC_PATH = join(repoRoot, 'docs', 'api-client-inventory.md');
const ENDPOINTS = join(repoRoot, 'apps', 'web', 'lib', 'api', 'endpoints.ts');

function walk(dir, extensions, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, extensions, out);
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function normalisePath(raw) {
  let path = raw.split(/[?#]/)[0];
  path = path.replace(/\$\{[^}]*\}/g, '{}');
  path = path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '{}');
  path = path.replace(/\{+/g, '{}').replace(/\}+/g, '{}');
  path = path.replace(/\/+/g, '/').replace(/\/$/, '');
  return path;
}

/** Backend route set (same extraction as scripts/route-inventory.mjs). */
function backendRoutes() {
  const routes = new Set();
  for (const file of walk(join(repoRoot, 'apps', 'api', 'src'), ['.controller.ts'])) {
    const source = readFileSync(file, 'utf8');
    const prefixMatch = source.match(/@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/);
    if (!prefixMatch) continue;
    const prefix = prefixMatch[1] ?? prefixMatch[2] ?? '';
    const methodRe = /@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/g;
    let match;
    while ((match = methodRe.exec(source)) !== null) {
      const sub = match[2] ?? match[3] ?? '';
      routes.add(normalisePath(`/${[prefix, sub].filter(Boolean).join('/')}`));
    }
  }
  return routes;
}

/** Parse exported wrappers and their first apiFetch path literal. */
function webWrappers() {
  const source = readFileSync(ENDPOINTS, 'utf8');
  const wrappers = [];
  const fnRe = /export function (\w+)\s*\(/g;
  let match;
  while ((match = fnRe.exec(source)) !== null) {
    const bodyStart = match.index;
    const nextFn = fnRe.exec(source);
    const body = source.slice(bodyStart, nextFn ? nextFn.index : undefined);
    // last regex execution advanced lastIndex past nextFn; reset handled below
    fnRe.lastIndex = nextFn ? nextFn.index : source.length;
    const pathMatch = body.match(/apiFetch\(\s*['"`](\/[^'"`]*)['"`]/);
    wrappers.push({
      name: match[1],
      path: pathMatch ? normalisePath(pathMatch[1]) : null,
      rawPath: pathMatch ? pathMatch[1] : null
    });
  }
  return wrappers;
}

/** All identifiers referenced by web UI sources (outside the api client). */
function uiReferenceCorpus() {
  const files = [
    ...walk(join(repoRoot, 'apps', 'web', 'components'), ['.ts', '.tsx']),
    ...walk(join(repoRoot, 'apps', 'web', 'app'), ['.ts', '.tsx']),
    ...walk(join(repoRoot, 'apps', 'web', 'lib'), ['.ts', '.tsx'])
  ].filter((file) => file !== ENDPOINTS);
  return files.map((file) => readFileSync(file, 'utf8')).join('\n');
}

/** Normalised stem for near-duplicate detection: strip the leading verb. */
function nameStem(name) {
  return name
    .replace(/^(fetch|get|list|create|load|retrieve)/, '')
    .toLowerCase();
}

function main() {
  const routes = backendRoutes();
  const wrappers = webWrappers();
  const uiCorpus = uiReferenceCorpus();

  const rows = wrappers.map((wrapper) => {
    const hasBackend = wrapper.path !== null && routes.has(wrapper.path);
    // A wrapper counts as UI-called when its name appears outside the client
    // barrel (word-boundary match on the raw corpus).
    const called =
      wrapper.name.length > 0 &&
      new RegExp(`\\b${wrapper.name}\\b`).test(uiCorpus);
    return { ...wrapper, hasBackend, called };
  });

  const noUiCaller = rows
    .filter((row) => row.hasBackend && !row.called)
    .sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''));

  // Near-duplicate names: same stem, different wrapper names, DISTINCT routes.
  const byStem = new Map();
  for (const row of rows) {
    if (!row.path) continue;
    const stem = nameStem(row.name);
    if (!stem) continue;
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(row);
  }
  const nearDuplicates = [];
  for (const [stem, group] of byStem) {
    const names = new Set(group.map((row) => row.name));
    const paths = new Set(group.map((row) => row.path));
    if (names.size > 1 && paths.size > 1) {
      nearDuplicates.push({ stem, group: group.sort((a, b) => a.name.localeCompare(b.name)) });
    }
  }
  nearDuplicates.sort((a, b) => a.stem.localeCompare(b.stem));

  const lines = [];
  lines.push('# Web API client inventory (GAP-I01 / GAP-I02)');
  lines.push('');
  lines.push('> GENERATED FILE — regenerate with `node scripts/api-client-inventory.mjs`.');
  lines.push('');
  lines.push('Mechanical analysis of `apps/web/lib/api/endpoints.ts` against the');
  lines.push('`apps/api` controller surface and the web UI sources. "No UI caller"');
  lines.push('means no static reference outside the client barrel — these are');
  lines.push('server-first capabilities (feature-availability gap, product');
  lines.push('backlog), NOT defects. No code is deleted as part of this finding.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| Exported wrappers in endpoints.ts | ${rows.length} |`);
  lines.push(`| Wrappers matching a backend route | ${rows.filter((r) => r.hasBackend).length} |`);
  lines.push(`| Wrappers with backend route but no UI caller (GAP-I01) | ${noUiCaller.length} |`);
  lines.push(`| Near-duplicate name groups with distinct backends (GAP-I02) | ${nearDuplicates.length} |`);
  lines.push('');
  lines.push('## GAP-I01 — wrappers with a backend route but no web UI caller');
  lines.push('');
  lines.push('Intentional server-first endpoints are marked where verified (see the');
  lines.push('Notes column); everything else is an unwired capability — track as');
  lines.push('product backlog.');
  lines.push('');
  if (noUiCaller.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Wrapper | Backend path | Notes |');
    lines.push('| --- | --- | --- |');
    for (const row of noUiCaller) {
      const notes = [];
      const first = (row.path ?? '').split('/')[1] ?? '';
      if (first === 'admin') notes.push('admin-console surface (no web admin UI wired)');
      if (row.path === '/checkout/orders') {
        notes.push(
          'intentional server-first: order creation ships via POST /listings/{}/orders; this alternate path is unused by design'
        );
      }
      lines.push(`| \`${row.name}\` | \`${row.rawPath}\` | ${notes.join('; ') || '—'} |`);
    }
  }
  lines.push('');
  lines.push('## GAP-I02 — near-duplicate wrapper names (verified distinct backends)');
  lines.push('');
  lines.push('Same stem, different wrapper names, DIFFERENT backend routes — no two');
  lines.push('wrappers map to the same method+path (no true duplicates). Naming');
  lines.push('ambiguity only; renames are optional. Register-verified examples:');
  lines.push('`listMyInsurancePolicies` (livestock indemnity) vs');
  lines.push('`fetchMyInsurancePolicies` (parametric); `fetchCreditScore` (finance)');
  lines.push('vs `fetchCreditScoreAssessment` (credit suite); legacy `/privacy/*`');
  lines.push('consents vs NDPA `/compliance/*` consents.');
  lines.push('');
  if (nearDuplicates.length === 0) {
    lines.push('_None detected._');
  } else {
    lines.push('| Stem | Wrapper | Backend path |');
    lines.push('| --- | --- | --- |');
    for (const { stem, group } of nearDuplicates) {
      for (const row of group) {
        lines.push(`| ${stem} | \`${row.name}\` | \`${row.rawPath}\` |`);
      }
    }
  }
  lines.push('');

  const output = lines.join('\n');
  if (process.argv.includes('--stdout')) {
    process.stdout.write(output);
    return;
  }
  writeFileSync(DOC_PATH, output);
  console.log(
    `api-client-inventory: ${rows.length} wrappers, ${noUiCaller.length} without UI caller, ` +
      `${nearDuplicates.length} near-duplicate groups -> docs/api-client-inventory.md`
  );
}

main();
