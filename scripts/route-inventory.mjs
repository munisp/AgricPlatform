#!/usr/bin/env node
/**
 * Route inventory (GAP-M22). Mechanically cross-references the NestJS
 * controller surface (apps/api) against frontend callers (apps/web and
 * apps/mobile apiFetch literals) and regenerates docs/route-inventory.md:
 *
 *   - every backend route WITHOUT a frontend caller is categorised as
 *     partner / admin / internal / future-web / mobile-only / dead
 *     (heuristic rules — see the generated document's methodology section);
 *   - routes that additionally have NO coverage signal (no controller spec,
 *     no e2e/test mention, no docs mention) are listed in a separate table.
 *
 * This is a MECHANICAL analysis: string-literal matching only. It cannot
 * see dynamically-built paths, gateway-rewritten paths or non-fetch
 * callers, so "no caller" means "no static caller literal found" — treat
 * the dead category as review candidates, never as proof. No claims beyond
 * what the regexes below can substantiate.
 *
 * Usage:
 *   node scripts/route-inventory.mjs            # rewrite docs/route-inventory.md
 *   node scripts/route-inventory.mjs --stdout   # print instead of writing
 *   node scripts/route-inventory.mjs --check    # exit 1 when the committed doc is stale
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC_PATH = join(repoRoot, 'docs', 'route-inventory.md');

/** Recursively collect files matching `extension` under `dir`. */
function walk(dir, extension, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, extension, out);
    else if (entry.name.endsWith(extension)) out.push(full);
  }
  return out;
}

/** Normalise a caller/route path: template params and :params both -> {}. */
function normalisePath(raw) {
  let path = raw.split(/[?#]/)[0];
  path = path.replace(/\$\{[^}]*\}/g, '{}'); // template literal params
  path = path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '{}'); // Nest :params
  path = path.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, '{}'); // {id} doc style
  path = path.replace(/\{encodeURIComponent[^}]*\}/g, '{}');
  path = path.replace(/\{+/g, '{}').replace(/\}+/g, '{}');
  path = path.replace(/\/+/g, '/').replace(/\/$/, '');
  return path;
}

/** Extract every backend route from the API controllers. */
function collectRoutes() {
  const controllers = walk(join(repoRoot, 'apps', 'api', 'src'), '.controller.ts');
  const routes = [];
  for (const file of controllers) {
    const source = readFileSync(file, 'utf8');
    const rel = relative(repoRoot, file);
    // One controller class per file in this codebase; take the FIRST
    // @Controller prefix as the file prefix.
    const prefixMatch = source.match(/@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/);
    if (!prefixMatch) continue;
    const prefix = prefixMatch[1] ?? prefixMatch[2] ?? '';
    const methodRe = /@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/g;
    let match;
    while ((match = methodRe.exec(source)) !== null) {
      const method = match[1].toUpperCase();
      const sub = match[2] ?? match[3] ?? '';
      const full = `/${[prefix, sub].filter(Boolean).join('/')}`;
      routes.push({
        method,
        path: full,
        normalised: normalisePath(full),
        controller: rel,
        module: rel.split('/')[3] ?? '' // apps/api/src/modules/<module>/...
      });
    }
  }
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return routes;
}

/** Extract caller path literals (apiFetch('/x'), apiFetch(`/x/${id}`)). */
function collectCallers(dirs) {
  const paths = new Set();
  const literalRe = /apiFetch\(\s*['"`](\/[^'"`]*)['"`]/g;
  for (const dir of dirs) {
    for (const file of walk(dir, '.ts')) {
      const source = readFileSync(file, 'utf8');
      let match;
      while ((match = literalRe.exec(source)) !== null) {
        paths.add(normalisePath(match[1]));
      }
    }
  }
  return paths;
}

/** Concatenated text of a file set (for coverage-signal substring checks). */
function corpus(files) {
  return files.map((file) => readFileSync(file, 'utf8')).join('\n');
}

/**
 * Coverage signals for a route:
 *  - controllerSpec: a spec file named after the controller exists
 *  - test: any spec/e2e source mentions the route path (colon or {} form)
 *  - docs: any docs/*.md mentions the route path (colon or {} form)
 */
function coverageFor(route, specByController, testCorpus, docsCorpus) {
  const colonForm = route.path;
  const braceForm = route.normalised;
  const mentions = (text) => text.includes(colonForm) || text.includes(braceForm);
  return {
    controllerSpec: specByController.has(route.controller),
    test: mentions(testCorpus),
    docs: mentions(docsCorpus)
  };
}

/**
 * Mechanical category heuristic for a route with NO web caller:
 *  - internal: service-to-service ingress (internal/*, sweeper/cron ops)
 *  - partner: partner/provider-facing surface (partner/*, provider webhook
 *    and telco callback ingress)
 *  - admin: admin/* operator console routes
 *  - mobile-only: has a mobile caller but no web caller
 *  - dead: no caller at all AND no coverage signal (review candidate)
 *  - future-web: everything else (no web caller found; web candidate)
 */
function categorize(route, webCallers, mobileCallers, coverage) {
  const first = route.path.split('/')[1] ?? '';
  const hasWeb = webCallers.has(route.normalised);
  const hasMobile = mobileCallers.has(route.normalised);
  if (first === 'internal') return 'internal';
  if (first === 'partner') return 'partner';
  if (first === 'admin') return 'admin';
  if ((first === 'integrations' && route.path.includes('webhook')) || first === 'ussd' || first === 'ivr') {
    return 'partner'; // provider / telco callback ingress
  }
  if (hasMobile && !hasWeb) return 'mobile-only';
  if (!hasMobile && !coverage.controllerSpec && !coverage.test && !coverage.docs) return 'dead';
  return 'future-web';
}

function main() {
  const args = process.argv.slice(2);
  const routes = collectRoutes();

  const webCallers = collectCallers([join(repoRoot, 'apps', 'web', 'lib')]);
  const mobileCallers = collectCallers([join(repoRoot, 'apps', 'mobile', 'src')]);

  // Controller-spec existence (same basename, e.g. foo.controller.spec.ts).
  const specFiles = walk(join(repoRoot, 'apps', 'api'), '.spec.ts');
  const specByController = new Set(
    specFiles
      .filter((file) => file.endsWith('.controller.spec.ts'))
      .map((file) => relative(repoRoot, file).replace('.controller.spec.ts', '.controller.ts'))
  );
  const testCorpus = corpus([
    ...specFiles,
    ...walk(join(repoRoot, 'apps', 'api', 'test'), '.ts'),
    ...walk(join(repoRoot, 'apps', 'api', 'test'), '.e2e-spec.ts')
  ]);
  const docsCorpus = corpus(walk(join(repoRoot, 'docs'), '.md'));

  const rows = routes.map((route) => {
    const coverage = coverageFor(route, specByController, testCorpus, docsCorpus);
    const hasWeb = webCallers.has(route.normalised);
    const hasMobile = mobileCallers.has(route.normalised);
    return {
      ...route,
      hasWeb,
      hasMobile,
      coverage,
      anyCoverage: coverage.controllerSpec || coverage.test || coverage.docs
    };
  });

  const noFrontend = rows.filter((row) => !row.hasWeb && !row.hasMobile);
  const mobileOnly = rows.filter((row) => !row.hasWeb && row.hasMobile);
  const uncategorized = rows.filter((row) => !row.hasWeb);
  for (const row of uncategorized) {
    row.category = categorize(row, webCallers, mobileCallers, row.coverage);
  }
  const zeroCoverage = uncategorized.filter(
    (row) => row.category !== 'mobile-only' && !row.anyCoverage
  );

  const categoryOrder = ['partner', 'admin', 'internal', 'future-web', 'mobile-only', 'dead'];
  const byCategory = new Map(categoryOrder.map((category) => [category, []]));
  for (const row of uncategorized) {
    byCategory.get(row.category)?.push(row);
  }

  const signal = (row) =>
    [
      row.coverage.controllerSpec ? 'controller-spec' : null,
      row.coverage.test ? 'test-mention' : null,
      row.coverage.docs ? 'doc-mention' : null
    ]
      .filter(Boolean)
      .join(', ') || '—';

  const lines = [];
  lines.push('# Route inventory — backend routes without a frontend caller');
  lines.push('');
  lines.push('> GENERATED FILE — regenerate with `node scripts/route-inventory.mjs`.');
  lines.push('> Do not edit by hand; `--check` fails CI when this drifts from the code.');
  lines.push('');
  lines.push('GAP-M22 triage: every `apps/api` controller route is cross-referenced');
  lines.push('against static `apiFetch` caller literals in `apps/web` and');
  lines.push('`apps/mobile`, and the routes without a caller are categorised.');
  lines.push('');
  lines.push('## Methodology and caveats');
  lines.push('');
  lines.push('Mechanical, string-literal analysis only:');
  lines.push('');
  lines.push('- Routes are parsed from `@Controller(prefix)` + `@Get/@Post/@Patch/@Put/@Delete`');
  lines.push('  decorators (the global `api/v1` prefix is omitted everywhere).');
  lines.push('- Callers are `apiFetch(\'/path\')` / template-literal literals in');
  lines.push('  `apps/web/lib/**` and `apps/mobile/src/**`; `${...}` and `:param` segments');
  lines.push('  are normalised to `{}` on both sides before matching.');
  lines.push('- "No caller" means NO STATIC CALLER LITERAL was found — dynamically-built');
  lines.push('  paths, gateway rewrites and non-`apiFetch` callers are invisible to this');
  lines.push('  analysis. `dead` rows are REVIEW CANDIDATES, not proven dead code.');
  lines.push('- Coverage signals: a same-name `*.controller.spec.ts` exists, any API');
  lines.push('  spec/e2e source mentions the route path, or any `docs/*.md` mentions it.');
  lines.push('');
  lines.push('Categories:');
  lines.push('');
  lines.push('| Category | Mechanical rule |');
  lines.push('| --- | --- |');
  lines.push('| `partner` | `partner/*` routes; provider/telco callback ingress (`integrations/*webhook*`, `ussd/*`, `ivr/*`) |');
  lines.push('| `admin` | `admin/*` operator routes |');
  lines.push('| `internal` | `internal/*` service-to-service ingress |');
  lines.push('| `mobile-only` | mobile caller literal exists, no web caller |');
  lines.push('| `dead` | no caller AND no coverage signal — removal-review candidate |');
  lines.push('| `future-web` | everything else without a web caller (web backlog candidates) |');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| Backend routes parsed | ${rows.length} |`);
  lines.push(`| Routes with a web caller | ${rows.filter((r) => r.hasWeb).length} |`);
  lines.push(`| Routes with a mobile caller only | ${mobileOnly.length} |`);
  lines.push(`| Routes with no frontend caller at all | ${noFrontend.length} |`);
  lines.push(`| Routes without a web caller (categorised below) | ${uncategorized.length} |`);
  lines.push(`| …of which zero coverage signal (no spec/test/doc) | ${zeroCoverage.length} |`);
  lines.push('');
  lines.push('| Category | Routes |');
  lines.push('| --- | ---: |');
  for (const category of categoryOrder) {
    lines.push(`| ${category} | ${byCategory.get(category).length} |`);
  }
  lines.push('');
  lines.push('## Routes without a web caller, by category');
  for (const category of categoryOrder) {
    const rowsInCategory = byCategory.get(category);
    lines.push('');
    lines.push(`### ${category} (${rowsInCategory.length})`);
    lines.push('');
    if (rowsInCategory.length === 0) {
      lines.push('_None._');
      continue;
    }
    lines.push('| Method | Path | Controller | Coverage signals |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of rowsInCategory) {
      lines.push(`| ${row.method} | \`${row.path}\` | ${row.controller} | ${signal(row)} |`);
    }
  }
  lines.push('');
  lines.push('## Zero-coverage routes (no web caller, no spec/test/doc signal)');
  lines.push('');
  lines.push('These are the highest-risk rows: mechanically unexercised and');
  lines.push('undocumented. Triage: wire a client, add tests/docs, or remove.');
  lines.push('');
  if (zeroCoverage.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Method | Path | Controller | Category |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of zeroCoverage) {
      lines.push(`| ${row.method} | \`${row.path}\` | ${row.controller} | ${row.category} |`);
    }
  }
  lines.push('');

  const output = lines.join('\n');

  if (args.includes('--stdout')) {
    process.stdout.write(output);
    return;
  }
  if (args.includes('--check')) {
    const committed = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, 'utf8') : '';
    if (committed !== output) {
      console.error('route-inventory: docs/route-inventory.md is stale — run node scripts/route-inventory.mjs');
      process.exit(1);
    }
    console.log('route-inventory: docs/route-inventory.md is up to date');
    return;
  }
  writeFileSync(DOC_PATH, output);
  console.log(
    `route-inventory: ${rows.length} routes, ${uncategorized.length} without a web caller ` +
      `(${zeroCoverage.length} zero-coverage) -> docs/route-inventory.md`
  );
}

main();
