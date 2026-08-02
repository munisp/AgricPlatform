import type { ApiClient } from './client';
import type {
  ApiListResponse,
  Course,
  MarketplaceListing,
  MyPathwayEnrolmentSummary,
  Opportunity,
  User,
  WeatherSnapshot
} from './types';

/**
 * Typed endpoint wrappers mirroring the NestJS controllers (and the web
 * client in apps/web/lib/api/endpoints.ts). Item endpoints unwrap
 * `{ data: T }`; list endpoints return the pagination envelope unless the
 * controller returns a plain `{ data: T[] }` (noted per function).
 */

/* ------------------------------- auth ---------------------------------- */

export function requestOtp(
  client: ApiClient,
  phone: string
): Promise<{ data: { requestId: string; devCode?: string } }> {
  return client.apiFetch('/auth/otp/request', { method: 'POST', body: { phone } });
}

export function verifyOtp(
  client: ApiClient,
  requestId: string,
  code: string
): Promise<{ data: { token: string; user: User } }> {
  return client.apiFetch('/auth/otp/verify', { method: 'POST', body: { requestId, code } });
}

export function fetchSession(client: ApiClient): Promise<{ data: { user: User } }> {
  return client.apiFetch('/auth/session');
}

/* ------------------------------ learning ------------------------------- */

export function listCourses(
  client: ApiClient,
  params: { category?: string; page?: number; pageSize?: number } = {}
): Promise<ApiListResponse<Course>> {
  return client.apiFetch('/courses', { query: { ...params } });
}

export function fetchCourse(client: ApiClient, id: string): Promise<{ data: Course }> {
  return client.apiFetch(`/courses/${encodeURIComponent(id)}`);
}

/* ----------------------------- marketplace ------------------------------ */

export function listListings(
  client: ApiClient,
  params: { kind?: MarketplaceListing['kind']; state?: string; page?: number; pageSize?: number } = {}
): Promise<ApiListResponse<MarketplaceListing>> {
  return client.apiFetch('/listings', { query: { ...params } });
}

export function fetchListing(client: ApiClient, id: string): Promise<{ data: MarketplaceListing }> {
  return client.apiFetch(`/listings/${encodeURIComponent(id)}`);
}

/* ------------------------------ dashboard ------------------------------- */

/** Training progress source: own pathway enrolments. Plain `{ data: T[] }`. */
export function listMyPathwayEnrolments(
  client: ApiClient
): Promise<{ data: MyPathwayEnrolmentSummary[] }> {
  return client.apiFetch('/pathway-enrolments/mine');
}

export function listOpportunities(
  client: ApiClient,
  params: { type?: string; page?: number; pageSize?: number } = {}
): Promise<ApiListResponse<Opportunity>> {
  return client.apiFetch('/opportunities', { query: { ...params } });
}

export function fetchWeather(client: ApiClient, state: string): Promise<{ data: WeatherSnapshot }> {
  return client.apiFetch(`/advisory/weather/${encodeURIComponent(state)}`);
}
