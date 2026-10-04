import type { ApiClient } from './client';
import type {
  AuthSession,
  FarmPlot,
  LearningEnrolment,
  ListingOrder,
  MarketplaceListing,
  NotificationMessage
} from './types';

interface RequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

export function fetchSession(client: ApiClient, options?: RequestOptions) {
  return client.apiFetch<AuthSession>('/auth/session', { signal: options?.signal });
}

export function listNotifications(client: ApiClient, userId: string, options?: RequestOptions) {
  return client.apiFetch<NotificationMessage[]>(
    `/notifications?userId=${encodeURIComponent(userId)}`,
    { signal: options?.signal }
  );
}

export function markNotificationRead(client: ApiClient, id: string, options?: RequestOptions) {
  return client.apiFetch<NotificationMessage>(`/notifications/${encodeURIComponent(id)}/read`, {
    method: 'POST',
    signal: options?.signal
  });
}

export interface ListingsQuery {
  kind?: MarketplaceListing['kind'];
  state?: string;
  q?: string;
}

export function listListings(client: ApiClient, query: ListingsQuery = {}, options?: RequestOptions) {
  const params = new URLSearchParams();
  if (query.kind) params.set('kind', query.kind);
  if (query.state) params.set('state', query.state);
  if (query.q) params.set('q', query.q);
  const qs = params.toString();
  return client.apiFetch<MarketplaceListing[]>(`/listings${qs ? `?${qs}` : ''}`, {
    signal: options?.signal
  });
}

export function fetchListing(client: ApiClient, id: string, options?: RequestOptions) {
  return client.apiFetch<MarketplaceListing>(`/listings/${encodeURIComponent(id)}`, {
    signal: options?.signal
  });
}

export function placeOrder(
  client: ApiClient,
  listingId: string,
  input: { buyerId: string; quantity: number },
  options?: RequestOptions
) {
  return client.apiFetch<ListingOrder>(`/listings/${encodeURIComponent(listingId)}/orders`, {
    method: 'POST',
    body: input,
    signal: options?.signal,
    idempotencyKey: options?.idempotencyKey
  });
}

export function listMyPlots(client: ApiClient, ownerUserId: string, options?: RequestOptions) {
  return client.apiFetch<FarmPlot[]>(`/farms/plots?ownerUserId=${encodeURIComponent(ownerUserId)}`, {
    signal: options?.signal
  });
}

export interface CreatePlotInput {
  name: string;
  state: string;
  lga: string;
  centroidLat: number;
  centroidLong: number;
  sizeHectares: number;
  soilType?: FarmPlot['soilType'];
  accuracyMeters?: number;
  clientId?: string;
}

export function createPlot(client: ApiClient, input: CreatePlotInput, options?: RequestOptions) {
  return client.apiFetch<FarmPlot>('/farms/plots', {
    method: 'POST',
    body: input,
    signal: options?.signal,
    idempotencyKey: options?.idempotencyKey
  });
}

export function listMyEnrolments(client: ApiClient, userId: string, options?: RequestOptions) {
  return client.apiFetch<LearningEnrolment[]>(
    `/learning/enrolments?userId=${encodeURIComponent(userId)}`,
    { signal: options?.signal }
  );
}
