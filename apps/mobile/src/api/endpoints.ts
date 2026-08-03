import type { ApiClient } from './client';
import type {
  Animal,
  ApiListResponse,
  Course,
  CreateFarmPlotInput,
  DraftOrder,
  FarmPlot,
  HealthRecall,
  MarketplaceListing,
  MyPathwayEnrolmentSummary,
  NotificationMessage,
  Opportunity,
  Order,
  OrderStatus,
  RegisterAnimalInput,
  User,
  VaccinationDueItem,
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

/** Login response (Wave P): access token + first-generation refresh token. */
export interface SessionTokens {
  token: string;
  refreshToken: string;
  refreshTokenExpiresAt?: string;
  user: User;
}

export function verifyOtp(
  client: ApiClient,
  requestId: string,
  code: string
): Promise<{ data: SessionTokens }> {
  return client.apiFetch('/auth/otp/verify', { method: 'POST', body: { requestId, code } });
}

export function fetchSession(client: ApiClient): Promise<{ data: { user: User } }> {
  return client.apiFetch('/auth/session');
}

/** Rotate a refresh token (the client also does this automatically on 401). */
export function refreshSession(
  client: ApiClient,
  refreshToken: string
): Promise<{ data: { user: User; refreshToken: string; refreshTokenExpiresAt?: string } }> {
  return client.apiFetch('/auth/refresh', { method: 'POST', body: { refreshToken } });
}

/** Revoke the refresh-token session on sign-out (idempotent server-side). */
export function logoutSession(
  client: ApiClient,
  refreshToken: string
): Promise<{ data: { revoked: boolean } }> {
  return client.apiFetch('/auth/logout', { method: 'POST', body: { refreshToken } });
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

/* ------------------------------- orders -------------------------------- */

/** Own orders (buyer side). Plain `{ data: Order[] }`. */
export function listMyOrders(
  client: ApiClient,
  buyerId: string,
  status?: OrderStatus
): Promise<{ data: Order[] }> {
  return client.apiFetch('/orders', { query: { buyerId, status } });
}

export function fetchOrder(client: ApiClient, id: string): Promise<{ data: Order }> {
  return client.apiFetch(`/orders/${encodeURIComponent(id)}`);
}

/** Draft orders created for the buyer by an agent (Wave M). Plain list. */
export function listDraftOrders(
  client: ApiClient,
  buyerId: string
): Promise<{ data: DraftOrder[] }> {
  return client.apiFetch('/draft-orders', { query: { buyerId } });
}

/** Buyer confirms a draft order into a normal order. */
export function confirmDraftOrder(
  client: ApiClient,
  id: string
): Promise<{ data: DraftOrder }> {
  return client.apiFetch(`/draft-orders/${encodeURIComponent(id)}/confirm`, { method: 'POST' });
}

/* ---------------------------- notifications ----------------------------- */

/** Own notifications, newest first. Plain `{ data: NotificationMessage[] }`. */
export function listNotifications(
  client: ApiClient,
  userId: string
): Promise<{ data: NotificationMessage[] }> {
  return client.apiFetch('/notifications', { query: { userId } });
}

export function markNotificationRead(
  client: ApiClient,
  id: string
): Promise<{ data: NotificationMessage }> {
  return client.apiFetch(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
}

/* ------------------------------ livestock ------------------------------- */

/** Own registered animals. Plain `{ data: Animal[] }`. */
export function listMyAnimals(client: ApiClient): Promise<{ data: Animal[] }> {
  return client.apiFetch('/livestock/animals/mine');
}

export function registerAnimal(
  client: ApiClient,
  input: RegisterAnimalInput
): Promise<{ data: Animal }> {
  return client.apiFetch('/livestock/animals', { method: 'POST', body: input });
}

/** Active disease recalls = pending health tasks for the dashboard card. */
export function listActiveRecalls(client: ApiClient): Promise<{ data: HealthRecall[] }> {
  return client.apiFetch('/livestock-health/recalls', { query: { status: 'active' } });
}

/**
 * Computed due-vaccination schedule (plain `{ data: VaccinationDueItem[] }`).
 * Farmers see their own animals; `days` is the lookahead window (default 30)
 * separating 'due' from 'upcoming'. This is the real pending-health-tasks
 * source for the dashboard card.
 */
export function listDueVaccinations(
  client: ApiClient,
  days = 30
): Promise<{ data: VaccinationDueItem[] }> {
  return client.apiFetch('/livestock-health/vaccinations/due', { query: { days } });
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

/* -------------------------------- farms --------------------------------- */

/**
 * Own farm plots (GET /farms/plots — owner-scoped server-side, so the
 * caller only ever receives their own). Plain `{ data: FarmPlot[] }`.
 */
export function listMyFarmPlots(client: ApiClient): Promise<{ data: FarmPlot[] }> {
  return client.apiFetch('/farms/plots');
}

/**
 * Direct plot creation. The capture screen normally writes through the
 * offline queue (src/offline/queue.ts) instead — this wrapper is for the
 * queue's flush sender and online-first callers.
 */
export function createFarmPlot(
  client: ApiClient,
  input: CreateFarmPlotInput,
  idempotencyKey?: string
): Promise<{ data: FarmPlot }> {
  return client.apiFetch('/farms/plots', { method: 'POST', body: input, idempotencyKey });
}
