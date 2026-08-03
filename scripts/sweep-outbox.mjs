#!/usr/bin/env node
/**
 * Outbox sweeper trigger (G17). The API deliberately starts NO in-process
 * timers; an external scheduler (cron, systemd timer, k8s CronJob) invokes
 * this script periodically to run one sweeper pass via the admin endpoint:
 *
 *   POST {API_BASE_URL}/admin/outbox/sweep   (admin role required)
 *
 * Environment:
 *   API_BASE_URL   e.g. https://api.example.com/api/v1
 *                  (default http://localhost:3001/api/v1)
 *   ADMIN_TOKEN    OIDC JWT for an admin principal, sent as a Bearer token.
 *                  In non-production deployments that honour x-user-id,
 *                  ADMIN_USER_ID may be used instead.
 *
 * Cron example (every minute):
 *   * * * * * API_BASE_URL=https://api.example.com/api/v1 ADMIN_TOKEN=… \
 *       node /app/scripts/sweep-outbox.mjs >> /var/log/outbox-sweep.log 2>&1
 *
 * Exit code is non-zero when the sweep call fails so the scheduler alerts.
 */

const baseUrl = (process.env.API_BASE_URL ?? 'http://localhost:3001/api/v1').replace(/\/+$/, '');
const token = process.env.ADMIN_TOKEN;
const adminUserId = process.env.ADMIN_USER_ID;

if (!token && !adminUserId) {
  console.error(
    'sweep-outbox: set ADMIN_TOKEN (admin OIDC JWT) or, non-production only, ADMIN_USER_ID.'
  );
  process.exit(2);
}

const headers = { 'content-type': 'application/json' };
if (token) {
  headers.authorization = `Bearer ${token}`;
} else {
  headers['x-user-id'] = adminUserId;
}

try {
  const response = await fetch(`${baseUrl}/admin/outbox/sweep`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(30_000)
  });
  const body = await response.text();
  if (!response.ok) {
    console.error(`sweep-outbox: HTTP ${response.status} — ${body}`);
    process.exit(1);
  }
  console.log(`sweep-outbox: OK ${body}`);
} catch (error) {
  console.error(`sweep-outbox: request failed — ${(error ?? '').message ?? error}`);
  process.exit(1);
}
