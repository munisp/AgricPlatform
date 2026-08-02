/**
 * k6 latency gate — core API routes (Wave P3 NFR tooling).
 *
 * Ramps to a modest staging load and FAILS the run when the p95 latency
 * budget is breached:
 *
 *   http_req_duration: p(95)<500        (all requests)
 *   http_req_duration{name:...}: p(95)<500 per route
 *   http_req_failed: rate<0.01
 *
 * Usage (staging gate, e.g. before a release):
 *   BASE_URL=https://staging-api.example.com k6 run scripts/perf/k6-gate.js
 *
 * k6 exits non-zero when a threshold fails, so CI/release automation can
 * block on this script directly.
 */
import http from 'k6/http';
import { check } from 'k6';
import { endpoints, params } from './k6-targets.js';

const perRouteThresholds = Object.fromEntries(
  endpoints.map((endpoint) => [`http_req_duration{name:${endpoint.name}}`, ['p(95)<500']])
);

export const options = {
  stages: [
    { duration: '30s', target: 10 }, // ramp up
    { duration: '1m', target: 10 }, // hold
    { duration: '15s', target: 0 } // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    ...perRouteThresholds
  }
};

export default function gate() {
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
