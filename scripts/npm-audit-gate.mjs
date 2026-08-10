#!/usr/bin/env node
/**
 * Blocking production dependency audit with VEX-style exceptions.
 *
 * Runs `npm audit --omit=dev --json`, collects high/critical advisories, and
 * fails the build on any advisory NOT excepted in scripts/audit-exceptions.json
 * (with justification + expiry). Excepted advisories are printed as warnings so
 * they stay visible. An exception whose advisory no longer appears in the audit
 * output is reported STALE (cleanup required) but does not fail the build; an
 * exception past its `expires` date DOES fail the build — exceptions decay.
 *
 * Usage: node scripts/npm-audit-gate.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exceptionsFile = JSON.parse(readFileSync(join(root, 'scripts/audit-exceptions.json'), 'utf8'));
const exceptions = new Map(exceptionsFile.exceptions.map((entry) => [entry.id, entry]));

let audit;
let auditRan = false;
try {
  const raw = execFileSync(
    'npm',
    ['audit', '--omit=dev', '--json', '--registry=https://registry.npmjs.org'],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024
    }
  );
  audit = JSON.parse(raw);
  auditRan = true;
} catch (error) {
  // npm audit exits non-zero when vulnerabilities exist — the JSON is on stdout.
  if (error.stdout) {
    try {
      audit = JSON.parse(error.stdout);
      auditRan = true;
    } catch {
      audit = undefined;
    }
  }
}

// Fail-closed: a gate that cannot see real audit data must NEVER pass silently.
// Mirrors (and offline/broken registries) return an error payload that would
// otherwise read as "zero vulnerabilities".
if (
  !auditRan ||
  !audit ||
  typeof audit !== 'object' ||
  audit.error ||
  typeof audit.vulnerabilities !== 'object' ||
  audit.vulnerabilities === null
) {
  console.error(
    'Dependency audit gate could not obtain a valid audit report (offline, unsupported registry mirror, or npm failure). Refusing to pass silently.'
  );
  process.exit(2);
}

const BLOCKING = new Set(['high', 'critical']);
const seen = new Map(); // advisory id -> { package, severity, title }

for (const finding of Object.values(audit.vulnerabilities ?? {})) {
  if (!BLOCKING.has(finding.severity)) continue;
  const advisories = finding.via?.filter((entry) => typeof entry === 'object') ?? [];
  for (const adv of advisories) {
    if (!BLOCKING.has(adv.severity ?? finding.severity)) continue;
    seen.set(String(adv.url ?? adv.source ?? adv.title), {
      package: finding.name,
      severity: adv.severity ?? finding.severity,
      title: adv.title
    });
  }
  // Packages whose `via` is all strings are transitively vulnerable through
  // those dependents — the underlying advisory object lives on the direct
  // dependency's entry and is counted exactly once there.
}

const today = new Date().toISOString().slice(0, 10);
const failures = [];
const excepted = [];

for (const [id, info] of seen) {
  const ghsa = id.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i)?.[0] ?? id;
  const exception = exceptions.get(ghsa);
  if (!exception) {
    failures.push(`${info.severity.toUpperCase()}: ${info.package} — ${info.title} (${ghsa})`);
  } else if (exception.expires < today) {
    failures.push(
      `EXPIRED exception ${ghsa} (${info.package}) expired ${exception.expires} — renew with fresh justification or fix the dependency`
    );
  } else {
    excepted.push(`excepted: ${info.package} ${ghsa} — ${exception.justification.slice(0, 120)}… (expires ${exception.expires})`);
  }
}

// Stale exceptions: advisory gone from audit output (fixed upstream or tree changed).
const activeIds = new Set(
  [...seen.keys()].map(
    (id) => id.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i)?.[0] ?? id
  )
);
for (const [ghsa, exception] of exceptions) {
  if (!activeIds.has(ghsa)) {
    console.warn(`STALE exception ${ghsa} (${exception.package}): advisory no longer appears in npm audit — remove it from scripts/audit-exceptions.json`);
  }
}

for (const line of excepted) console.warn(line);

if (failures.length > 0) {
  console.error(`\nBlocking dependency audit FAILED — ${failures.length} unexcepted high/critical advisory(ies):`);
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}

console.log(
  `Dependency audit gate passed: 0 unexcepted high/critical advisories (${excepted.length} excepted with justification, ${seen.size} total blocking-severity findings reviewed).`
);
