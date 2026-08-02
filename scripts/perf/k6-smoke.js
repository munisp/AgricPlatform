/**
 * k6 smoke test — core API routes (Wave P3 NFR tooling).
 *
 * Verifies the core routes respond correctly under minimal load (1 VU).
 * Use k6-gate.js for the latency-gated load run.
 *
 * Usage:
 *   k6 run scripts/perf/k6-smoke.js
 *   BASE_URL=https://staging-api.example.com k6 run scripts/perf/k6-smoke.js
 */
import http from 'k6/http';
import { check } from 'k6';
import { endpoints, params } from './k6-targets.js';

export const options = {
  vus: 1,
  duration: '30s',
  thresholds: {
    // Smoke only asserts correctness, not latency.
    http_req_failed: ['rate<0.01']
  }
};

export default function smoke() {
  for (const endpoint of endpoints) {
    const response =
      endpoint.method === 'POST'
        ? http.post(endpoint.url, JSON.stringify(endpoint.body), params(endpoint.name))
        : http.get(endpoint.url, params(endpoint.name));
    check(response, {
      [`${endpoint.name} status ${endpoint.expect}`]: (r) => r.status === endpoint.expect
    });
  }
}
