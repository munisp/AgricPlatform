#!/usr/bin/env node
/**
 * Observability config validator (Wave OPS; run by the CI ops-lint job).
 * Parses the Prometheus scrape config, alert rules and Grafana dashboard
 * and enforces their structural contract — a broken YAML or a dashboard
 * with expression-less panels should fail CI before it fails a 3am page.
 *
 *   node scripts/validate-observability.mjs
 *
 * Exit 0 = all configs valid. Uses js-yaml from the workspace install.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OBS = path.join(ROOT, 'infra', 'observability');

const problems = [];
const check = (ok, message) => {
  if (!ok) {
    problems.push(message);
  }
};

// --- prometheus.yml ---
const prometheus = yaml.load(readFileSync(path.join(OBS, 'prometheus.yml'), 'utf8'));
check(Array.isArray(prometheus?.scrape_configs), 'prometheus.yml: scrape_configs missing');
check(
  prometheus.scrape_configs?.some((job) => job.metrics_path === '/api/v1/metrics'),
  'prometheus.yml: no job scrapes /api/v1/metrics'
);
check(
  JSON.stringify(prometheus).includes('credentials_file') === true,
  'prometheus.yml: scrape credentials must come from credentials_file (never inline tokens)'
);

// --- alerts.yml ---
const alerts = yaml.load(readFileSync(path.join(OBS, 'alerts.yml'), 'utf8'));
check(Array.isArray(alerts?.groups) && alerts.groups.length > 0, 'alerts.yml: no rule groups');
let ruleCount = 0;
for (const group of alerts.groups ?? []) {
  check(typeof group.name === 'string', 'alerts.yml: group without a name');
  for (const rule of group.rules ?? []) {
    ruleCount += 1;
    check(typeof rule.alert === 'string' && rule.alert.length > 0, `alerts.yml: rule in ${group.name} missing alert name`);
    check(typeof rule.expr === 'string' && rule.expr.length > 0, `alerts.yml: ${rule.alert} missing expr`);
    check(['page', 'warn'].includes(rule.labels?.severity), `alerts.yml: ${rule.alert} needs labels.severity page|warn`);
    check(typeof rule.annotations?.action === 'string', `alerts.yml: ${rule.alert} missing runbook action annotation`);
  }
}
check(ruleCount >= 8, `alerts.yml: only ${ruleCount} rules — expected the SLO set`);

// --- grafana dashboard ---
const dashboard = JSON.parse(readFileSync(path.join(OBS, 'grafana', 'dashboards', 'platform.json'), 'utf8'));
check(Array.isArray(dashboard.panels) && dashboard.panels.length >= 8, 'platform.json: too few panels');
check(typeof dashboard.title === 'string' && typeof dashboard.uid === 'string', 'platform.json: missing title/uid');
for (const panel of dashboard.panels ?? []) {
  const targets = panel.targets ?? [];
  check(targets.length > 0 && targets.every((t) => typeof t.expr === 'string' && t.expr.length > 0),
    `platform.json: panel "${panel.title}" has a target without an expr`);
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`FAIL ${problem}`);
  }
  process.exit(1);
}
console.log(`validate-observability: OK (${ruleCount} alert rules, ${dashboard.panels.length} dashboard panels)`);
