/**
 * Shared endpoint catalogue for the k6 smoke/gate scripts (Wave P3).
 *
 * BASE_URL points at the API origin (no path suffix); routes live under the
 * global /api/v1 prefix. DASHBOARD_USER_ID defaults to the seeded farmer so
 * the dashboard route resolves against a seeded/staging database.
 */
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
const PREFIX = `${BASE_URL}/api/v1`;
const DASHBOARD_USER_ID = __ENV.DASHBOARD_USER_ID || 'user-adamu';

export const endpoints = [
  { name: 'health', method: 'GET', url: `${PREFIX}/health`, expect: 200 },
  {
    name: 'auth_otp_request',
    method: 'POST',
    url: `${PREFIX}/auth/otp/request`,
    body: { phone: '+2348012345678' },
    expect: 201
  },
  { name: 'dashboard', method: 'GET', url: `${PREFIX}/dashboard/${DASHBOARD_USER_ID}`, expect: 200 },
  { name: 'courses_list', method: 'GET', url: `${PREFIX}/courses`, expect: 200 },
  { name: 'marketplace_list', method: 'GET', url: `${PREFIX}/listings`, expect: 200 }
];

export function params(name) {
  return { headers: { 'Content-Type': 'application/json' }, tags: { name } };
}
