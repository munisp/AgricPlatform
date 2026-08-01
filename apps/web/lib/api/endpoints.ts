import type {
  AdvisoryItem,
  ApiListResponse,
  AuditEvent,
  Certificate,
  Chapter,
  ChapterEvent,
  ConsentRecord,
  Course,
  CreditProfile,
  Enrolment,
  ForumTopic,
  IntegrationStatus,
  MarketplaceListing,
  MentorRequest,
  NotificationMessage,
  NotificationPreference,
  Opportunity,
  OpportunityApplication,
  Order,
  PlatformMetric,
  Profile,
  User,
  UserRole,
  VaultDocument
} from '@agric-platform/shared';
import { apiFetch } from './client';

/**
 * Typed endpoint wrappers mirroring the NestJS controllers under
 * apps/api/src/modules. Item endpoints unwrap `{ data: T }`; list endpoints
 * return the pagination envelope `{ data, total, page, pageSize }` unless the
 * controller returns a plain `{ data: T[] }` (noted per function).
 */

/* ------------------------------- auth ---------------------------------- */

export interface RegisterInput {
  phone: string;
  fullName: string;
  email?: string;
  roles: UserRole[];
  preferredLanguage: 'en' | 'ha' | 'yo' | 'ig';
}

export interface RegisteredSession {
  token: string;
  user: User;
}

export function register(input: RegisterInput): Promise<{ data: RegisteredSession }> {
  return apiFetch('/auth/register', { method: 'POST', body: input });
}

export function fetchSession(): Promise<{ data: { user: User } }> {
  return apiFetch('/auth/session');
}

/* ------------------------------ profiles ------------------------------- */

export type UpsertProfileInput = Partial<
  Pick<
    Profile,
    'location' | 'farmingInterests' | 'valueChains' | 'bio' | 'farmSizeHectares' | 'yearsExperience'
  >
>;

export function fetchProfile(userId: string): Promise<{ data: Profile }> {
  return apiFetch(`/profiles/${encodeURIComponent(userId)}`);
}

export function upsertProfile(
  userId: string,
  input: UpsertProfileInput
): Promise<{ data: Profile }> {
  return apiFetch(`/profiles/${encodeURIComponent(userId)}`, { method: 'PUT', body: input });
}

/* ------------------------------ dashboard ------------------------------ */

export interface DashboardWidget {
  key: string;
  title: string;
  kind: 'metric' | 'list' | 'action';
  data: unknown;
}

export interface DashboardView {
  userId: string;
  roles: string[];
  metrics: PlatformMetric[];
  widgets: DashboardWidget[];
}

export function fetchDashboard(userId: string): Promise<{ data: DashboardView }> {
  return apiFetch(`/dashboard/${encodeURIComponent(userId)}`);
}

/* ---------------------------- opportunities ---------------------------- */

export interface ListOpportunitiesParams {
  state?: string;
  valueChain?: string;
  type?: Opportunity['type'];
  active?: boolean;
  page?: number;
  pageSize?: number;
}

export function listOpportunities(
  params: ListOpportunitiesParams = {}
): Promise<ApiListResponse<Opportunity>> {
  return apiFetch('/opportunities', { query: { ...params } });
}

export function applyToOpportunity(
  opportunityId: string,
  input: { userId: string; notes?: string },
  idempotencyKey?: string
): Promise<{ data: OpportunityApplication }> {
  return apiFetch(`/opportunities/${encodeURIComponent(opportunityId)}/apply`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listApplications(params: {
  userId?: string;
  opportunityId?: string;
  status?: string;
}): Promise<{ data: OpportunityApplication[] }> {
  return apiFetch('/applications', { query: { ...params } });
}

/* ---------------------------- notifications ---------------------------- */

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listNotifications(userId: string): Promise<{ data: NotificationMessage[] }> {
  return apiFetch('/notifications', { query: { userId } });
}

export function fetchNotificationPreferences(
  userId: string
): Promise<{ data: NotificationPreference[] }> {
  return apiFetch(`/notifications/preferences/${encodeURIComponent(userId)}`);
}

export function setNotificationPreferences(
  userId: string,
  preferences: Array<{ channel: NotificationPreference['channel']; enabled: boolean }>
): Promise<{ data: NotificationPreference[] }> {
  return apiFetch(`/notifications/preferences/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    body: { preferences }
  });
}

/* ----------------------------- marketplace ----------------------------- */

export interface ListListingsParams {
  kind?: MarketplaceListing['kind'];
  state?: string;
  crop?: string;
  q?: string;
  active?: boolean;
  page?: number;
  pageSize?: number;
}

export function listListings(
  params: ListListingsParams = {}
): Promise<ApiListResponse<MarketplaceListing>> {
  return apiFetch('/listings', { query: { ...params } });
}

export type CreateListingInput = Pick<
  MarketplaceListing,
  'sellerId' | 'kind' | 'title' | 'quantity' | 'unit' | 'priceNaira' | 'location'
> &
  Partial<Pick<MarketplaceListing, 'crop' | 'harvestDate'>>;

export function createListing(
  input: CreateListingInput,
  idempotencyKey?: string
): Promise<{ data: MarketplaceListing }> {
  return apiFetch('/listings', { method: 'POST', body: input, idempotencyKey });
}

export function placeOrder(
  listingId: string,
  input: { buyerId: string; quantity: number },
  idempotencyKey?: string
): Promise<{ data: Order }> {
  return apiFetch(`/listings/${encodeURIComponent(listingId)}/orders`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listOrders(params: {
  buyerId?: string;
  sellerId?: string;
  status?: string;
}): Promise<{ data: Order[] }> {
  return apiFetch('/orders', { query: { ...params } });
}

/* ------------------------------ chapters ------------------------------- */

export function listChapters(params: {
  level?: Chapter['level'];
  state?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<ApiListResponse<Chapter>> {
  return apiFetch('/chapters', { query: { ...params } });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listChapterEvents(chapterId: string): Promise<{ data: ChapterEvent[] }> {
  return apiFetch(`/chapters/${encodeURIComponent(chapterId)}/events`);
}

export function rsvpToEvent(
  eventId: string,
  userId: string,
  idempotencyKey?: string
): Promise<{ data: ChapterEvent }> {
  return apiFetch(`/events/${encodeURIComponent(eventId)}/rsvp`, {
    method: 'POST',
    body: { userId },
    idempotencyKey
  });
}

export function recordAttendance(
  eventId: string,
  userId: string,
  idempotencyKey?: string
): Promise<{ data: ChapterEvent }> {
  return apiFetch(`/events/${encodeURIComponent(eventId)}/attendance`, {
    method: 'POST',
    body: { userId },
    idempotencyKey
  });
}

/* ------------------------------ community ------------------------------ */

export function listTopics(params: {
  category?: string;
  state?: string;
  crop?: string;
  q?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<ApiListResponse<ForumTopic>> {
  return apiFetch('/community/topics', { query: { ...params } });
}

export function createTopic(input: {
  title: string;
  category: string;
  authorId: string;
  state?: string;
  crop?: string;
}): Promise<{ data: ForumTopic }> {
  return apiFetch('/community/topics', { method: 'POST', body: input });
}

export function requestMentor(input: {
  userId: string;
  crop: string;
  state: string;
  challenge: string;
}): Promise<{ data: MentorRequest }> {
  return apiFetch('/community/mentors/requests', { method: 'POST', body: input });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listMentorRequests(params: {
  userId?: string;
  status?: string;
}): Promise<{ data: MentorRequest[] }> {
  return apiFetch('/community/mentors/requests', { query: { ...params } });
}

/* ------------------------------ learning ------------------------------- */

export function listCourses(params: {
  category?: string;
  level?: Course['level'];
  language?: string;
  q?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<ApiListResponse<Course>> {
  return apiFetch('/courses', { query: { ...params } });
}

export function enrolInCourse(
  courseId: string,
  userId: string,
  idempotencyKey?: string
): Promise<{ data: Enrolment }> {
  return apiFetch(`/courses/${encodeURIComponent(courseId)}/enrol`, {
    method: 'POST',
    body: { userId },
    idempotencyKey
  });
}

export function updateEnrolmentProgress(
  enrolmentId: string,
  progressPercent: number
): Promise<{ data: Enrolment }> {
  return apiFetch(`/enrolments/${encodeURIComponent(enrolmentId)}/progress`, {
    method: 'PATCH',
    body: { progressPercent }
  });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listEnrolments(userId: string): Promise<{ data: Enrolment[] }> {
  return apiFetch(`/users/${encodeURIComponent(userId)}/enrolments`);
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listCertificates(userId: string): Promise<{ data: Certificate[] }> {
  return apiFetch(`/users/${encodeURIComponent(userId)}/certificates`);
}

/* -------------------------------- admin -------------------------------- */

export interface AdminReviewQueue {
  flaggedTopics: number;
  pendingDocuments: number;
  pendingApplications: number;
  items: Array<{ type: string; id: string; summary: string }>;
}

export function adminListUsers(params: {
  role?: UserRole;
  q?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<ApiListResponse<User>> {
  return apiFetch('/users', { query: { ...params } });
}

export function adminReviewQueue(): Promise<{ data: AdminReviewQueue }> {
  return apiFetch('/admin/review-queue');
}

export function adminKpis(): Promise<{ data: PlatformMetric[] }> {
  return apiFetch('/admin/kpis');
}

export function adminAudit(): Promise<{ data: AuditEvent[] }> {
  return apiFetch('/admin/audit');
}

/* ------------------------------- partner ------------------------------- */

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function partnerProgrammes(partnerId: string): Promise<{ data: Opportunity[] }> {
  return apiFetch(`/partner/${encodeURIComponent(partnerId)}/programmes`);
}

export interface PartnerImpactReport {
  partnerId: string;
  generatedAt: string;
  programmes: number;
  applications: Record<string, number>;
  participants: number;
  completedTrainings: number;
}

export function partnerImpact(partnerId: string): Promise<{ data: PartnerImpactReport }> {
  return apiFetch(`/partner/${encodeURIComponent(partnerId)}/reports/impact`);
}

/* ------------------------------- finance ------------------------------- */

export function fetchCreditProfile(userId: string): Promise<{ data: CreditProfile }> {
  return apiFetch(`/finance/credit-profile/${encodeURIComponent(userId)}`);
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listDocuments(params: {
  userId?: string;
  status?: VaultDocument['status'];
}): Promise<{ data: VaultDocument[] }> {
  return apiFetch('/finance/documents', { query: { ...params } });
}

export function uploadDocument(input: {
  userId: string;
  kind: VaultDocument['kind'];
  fileName: string;
}): Promise<{ data: VaultDocument }> {
  return apiFetch('/finance/documents', { method: 'POST', body: input });
}

/* ------------------------------- privacy ------------------------------- */

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listConsents(userId: string): Promise<{ data: ConsentRecord[] }> {
  return apiFetch(`/privacy/consents/${encodeURIComponent(userId)}`);
}

export function recordConsent(input: {
  userId: string;
  purpose: string;
  granted: boolean;
  source: string;
}): Promise<{ data: ConsentRecord }> {
  return apiFetch('/privacy/consents', { method: 'POST', body: input });
}

export function exportPrivacyData(userId: string): Promise<{ data: unknown }> {
  return apiFetch(`/privacy/export/${encodeURIComponent(userId)}`);
}

export interface DeletionRequestResult {
  id: string;
  userId: string;
  status: string;
  requestedAt: string;
}

export function requestAccountDeletion(
  userId: string
): Promise<{ data: DeletionRequestResult }> {
  return apiFetch(`/privacy/delete/${encodeURIComponent(userId)}`, { method: 'POST' });
}

/* --------------------------- cross-cutting ----------------------------- */

export interface SearchResult {
  type: 'course' | 'opportunity' | 'listing' | 'advisory' | 'chapter' | 'topic';
  id: string;
  title: string;
  summary: string;
  score: number;
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function searchPlatform(params: {
  q: string;
  types?: string;
  state?: string;
  limit?: number;
}): Promise<{ data: SearchResult[] }> {
  return apiFetch('/search', { query: { ...params } });
}

export function listAdvisory(params: {
  kind?: AdvisoryItem['kind'];
  state?: string;
  crop?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<ApiListResponse<AdvisoryItem>> {
  return apiFetch('/advisory', { query: { ...params } });
}

/** Admin-gated. Note: returns a plain `{ data: T[] }` envelope. */
export function listIntegrations(): Promise<{ data: IntegrationStatus[] }> {
  return apiFetch('/integrations');
}

export function fetchPlatformMetrics(): Promise<{ data: PlatformMetric[] }> {
  return apiFetch('/analytics/metrics');
}
