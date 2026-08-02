import type {
  AdvisoryItem,
  ApiListResponse,
  AuditEvent,
  BookingStatus,
  CampusClub,
  CampusClubMembership,
  Certificate,
  Chapter,
  ChapterEvent,
  CohortThread,
  CohortThreadPost,
  ConsentRecord,
  Course,
  CreditProfile,
  CreditScoreResult,
  Enrolment,
  EscrowRecord,
  ForumTopic,
  InstallmentStatus,
  IntegrationStatus,
  Invoice,
  KnowledgeFormat,
  KnowledgeResource,
  LanguageCode,
  LeaderboardEntry,
  Lender,
  LoanApplication,
  MarketplaceListing,
  MentorRequest,
  MilestoneProgress,
  MilestoneProgressStatus,
  NotificationMessage,
  NotificationPreference,
  Opportunity,
  OpportunityApplication,
  Order,
  PathwayEnrolment,
  PathwayStage,
  PathwayTemplate,
  PathwayTrack,
  PlatformMetric,
  PodcastEpisode,
  Profile,
  ProgrammeCohort,
  ProgrammeEnrolment,
  ProgrammeMilestone,
  ProgrammeType,
  RepaymentInstallment,
  ServiceBooking,
  ServiceOffering,
  ServiceReview,
  ServiceSupplier,
  Shipment,
  StageProgress,
  SupplierCategory,
  SupplierVerificationStatus,
  TrendingQuery,
  User,
  UserRole,
  VaultDocument,
  Webinar,
  WebinarRegistration,
  WebinarStatus
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

/* ------------------------- services marketplace ------------------------ */

export function listServiceSuppliers(params: {
  category?: SupplierCategory;
  state?: string;
  verificationStatus?: SupplierVerificationStatus;
  page?: number;
  pageSize?: number;
} = {}): Promise<ApiListResponse<ServiceSupplier>> {
  return apiFetch('/service-suppliers', { query: { ...params } });
}

export function fetchServiceSupplier(id: string): Promise<{ data: ServiceSupplier }> {
  return apiFetch(`/service-suppliers/${encodeURIComponent(id)}`);
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listSupplierOfferings(supplierId: string): Promise<{ data: ServiceOffering[] }> {
  return apiFetch(`/service-suppliers/${encodeURIComponent(supplierId)}/offerings`);
}

export function createServiceBooking(
  offeringId: string,
  input: {
    customerId: string;
    quantity?: number;
    scheduledStart: string;
    scheduledEnd: string;
    notes?: string;
  },
  idempotencyKey?: string
): Promise<{ data: ServiceBooking }> {
  return apiFetch(`/service-offerings/${encodeURIComponent(offeringId)}/bookings`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

export function fetchServiceBooking(id: string): Promise<{ data: ServiceBooking }> {
  return apiFetch(`/service-bookings/${encodeURIComponent(id)}`);
}

/** Own bookings, newest first. Plain `{ data: T[] }` envelope. */
export function listMyServiceBookings(params: {
  status?: BookingStatus;
} = {}): Promise<{ data: ServiceBooking[] }> {
  return apiFetch('/service-bookings/mine', { query: { ...params } });
}

export function quoteServiceBooking(
  id: string,
  totalNaira: number
): Promise<{ data: ServiceBooking }> {
  return apiFetch(`/service-bookings/${encodeURIComponent(id)}/quote`, {
    method: 'POST',
    body: { totalNaira }
  });
}

export function setServiceBookingStatus(
  id: string,
  status: BookingStatus
): Promise<{ data: ServiceBooking }> {
  return apiFetch(`/service-bookings/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    body: { status }
  });
}

export function createServiceReview(
  bookingId: string,
  input: { authorId: string; rating: number; comment?: string },
  idempotencyKey?: string
): Promise<{ data: ServiceReview }> {
  return apiFetch(`/service-bookings/${encodeURIComponent(bookingId)}/review`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listSupplierReviews(supplierId: string): Promise<{ data: ServiceReview[] }> {
  return apiFetch(`/service-suppliers/${encodeURIComponent(supplierId)}/reviews`);
}

/* ------------------------------ programmes ----------------------------- */

export function listProgrammeCohorts(params: {
  programmeType?: ProgrammeType;
  status?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<ApiListResponse<ProgrammeCohort>> {
  return apiFetch('/programme-cohorts', { query: { ...params } });
}

export function fetchProgrammeCohort(id: string): Promise<{ data: ProgrammeCohort }> {
  return apiFetch(`/programme-cohorts/${encodeURIComponent(id)}`);
}

/** Own cohort enrolment with milestone progress summary (`/programme-cohorts/mine`). */
export interface MyCohortEnrolmentSummary {
  enrolment: ProgrammeEnrolment;
  cohort: ProgrammeCohort;
  milestonesTotal: number;
  milestonesCompleted: number;
}

/** Own cohort enrolments, newest first. Plain `{ data: T[] }` envelope. */
export function listMyCohortEnrolments(): Promise<{ data: MyCohortEnrolmentSummary[] }> {
  return apiFetch('/programme-cohorts/mine');
}

export function enrolInCohort(
  cohortId: string,
  input: { userId: string; declaredAge?: number; declaredGender?: 'female' | 'male' | 'other' },
  idempotencyKey?: string
): Promise<{ data: ProgrammeEnrolment }> {
  return apiFetch(`/programme-cohorts/${encodeURIComponent(cohortId)}/enrolments`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

export function withdrawFromCohort(
  cohortId: string,
  userId: string
): Promise<{ data: ProgrammeEnrolment }> {
  return apiFetch(`/programme-cohorts/${encodeURIComponent(cohortId)}/enrolments/withdraw`, {
    method: 'POST',
    body: { userId }
  });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listCohortMilestones(cohortId: string): Promise<{ data: ProgrammeMilestone[] }> {
  return apiFetch(`/programme-cohorts/${encodeURIComponent(cohortId)}/milestones`);
}

export function setMilestoneProgress(
  milestoneId: string,
  input: { userId: string; status: MilestoneProgressStatus }
): Promise<{ data: MilestoneProgress }> {
  return apiFetch(`/programme-milestones/${encodeURIComponent(milestoneId)}/progress`, {
    method: 'POST',
    body: input
  });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function fetchCohortProgress(
  cohortId: string,
  userId: string
): Promise<{ data: MilestoneProgress[] }> {
  return apiFetch(`/programme-cohorts/${encodeURIComponent(cohortId)}/progress`, {
    query: { userId }
  });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function fetchCohortLeaderboard(cohortId: string): Promise<{ data: LeaderboardEntry[] }> {
  return apiFetch(`/programme-cohorts/${encodeURIComponent(cohortId)}/leaderboard`);
}

/** Enrolled members + moderators only (403 otherwise). Plain `{ data: T[] }`. */
export function listCohortThreads(cohortId: string): Promise<{ data: CohortThread[] }> {
  return apiFetch(`/programme-cohorts/${encodeURIComponent(cohortId)}/threads`);
}

export function createCohortThread(
  cohortId: string,
  input: { title: string; authorId: string }
): Promise<{ data: CohortThread }> {
  return apiFetch(`/programme-cohorts/${encodeURIComponent(cohortId)}/threads`, {
    method: 'POST',
    body: input
  });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listThreadPosts(threadId: string): Promise<{ data: CohortThreadPost[] }> {
  return apiFetch(`/programme-threads/${encodeURIComponent(threadId)}/posts`);
}

export function createThreadPost(
  threadId: string,
  input: { authorId: string; body: string }
): Promise<{ data: CohortThreadPost }> {
  return apiFetch(`/programme-threads/${encodeURIComponent(threadId)}/posts`, {
    method: 'POST',
    body: input
  });
}

/* ------------------------------- pathways ------------------------------ */

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listPathwayTemplates(params: {
  track?: PathwayTrack;
} = {}): Promise<{ data: PathwayTemplate[] }> {
  return apiFetch('/pathway-templates', { query: { ...params } });
}

export function fetchPathwayTemplate(
  id: string
): Promise<{ data: { template: PathwayTemplate; stages: PathwayStage[] } }> {
  return apiFetch(`/pathway-templates/${encodeURIComponent(id)}`);
}

export function enrolInPathway(
  templateId: string,
  userId: string,
  idempotencyKey?: string
): Promise<{ data: PathwayEnrolment }> {
  return apiFetch(`/pathway-templates/${encodeURIComponent(templateId)}/enrol`, {
    method: 'POST',
    body: { userId },
    idempotencyKey
  });
}

export function fetchPathwayEnrolment(
  id: string
): Promise<{ data: { enrolment: PathwayEnrolment; progress: StageProgress[] } }> {
  return apiFetch(`/pathway-enrolments/${encodeURIComponent(id)}`);
}

/** Own pathway enrolment with template + stage progress summary (`/pathway-enrolments/mine`). */
export interface MyPathwayEnrolmentSummary {
  enrolment: PathwayEnrolment;
  template: PathwayTemplate;
  stagesTotal: number;
  stagesCompleted: number;
  currentStageTitle?: string;
}

/** Own pathway enrolments, newest first. Plain `{ data: T[] }` envelope. */
export function listMyPathwayEnrolments(): Promise<{ data: MyPathwayEnrolmentSummary[] }> {
  return apiFetch('/pathway-enrolments/mine');
}

/** Completes the current stage (evidence required) and advances. */
export function completePathwayStage(
  enrolmentId: string,
  evidence: string
): Promise<{ data: PathwayEnrolment }> {
  return apiFetch(`/pathway-enrolments/${encodeURIComponent(enrolmentId)}/complete-stage`, {
    method: 'POST',
    body: { evidence }
  });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listCampusClubs(params: {
  state?: string;
  institution?: string;
  nyscOnly?: boolean;
} = {}): Promise<{ data: CampusClub[] }> {
  return apiFetch('/campus-clubs', { query: { ...params } });
}

export function fetchCampusClub(id: string): Promise<{ data: CampusClub }> {
  return apiFetch(`/campus-clubs/${encodeURIComponent(id)}`);
}

export function joinCampusClub(
  clubId: string,
  userId: string,
  idempotencyKey?: string
): Promise<{ data: CampusClubMembership }> {
  return apiFetch(`/campus-clubs/${encodeURIComponent(clubId)}/members`, {
    method: 'POST',
    body: { userId },
    idempotencyKey
  });
}

/* ------------------------------- knowledge ----------------------------- */

export function listKnowledgeResources(params: {
  tag?: string;
  language?: LanguageCode;
  format?: KnowledgeFormat;
  offlineAvailable?: boolean;
  page?: number;
  pageSize?: number;
} = {}): Promise<ApiListResponse<KnowledgeResource>> {
  return apiFetch('/knowledge-resources', { query: { ...params } });
}

export function fetchKnowledgeResource(id: string): Promise<{ data: KnowledgeResource }> {
  return apiFetch(`/knowledge-resources/${encodeURIComponent(id)}`);
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listPodcastEpisodes(): Promise<{ data: PodcastEpisode[] }> {
  return apiFetch('/podcast-episodes');
}

export function fetchPodcastEpisode(id: string): Promise<{ data: PodcastEpisode }> {
  return apiFetch(`/podcast-episodes/${encodeURIComponent(id)}`);
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listWebinars(params: {
  status?: WebinarStatus;
} = {}): Promise<{ data: Webinar[] }> {
  return apiFetch('/webinars', { query: { ...params } });
}

export function fetchWebinar(id: string): Promise<{ data: Webinar }> {
  return apiFetch(`/webinars/${encodeURIComponent(id)}`);
}

export function registerForWebinar(
  webinarId: string,
  userId: string,
  idempotencyKey?: string
): Promise<{ data: WebinarRegistration }> {
  return apiFetch(`/webinars/${encodeURIComponent(webinarId)}/registrations`, {
    method: 'POST',
    body: { userId },
    idempotencyKey
  });
}

/** Own webinar registrations, newest first. Plain `{ data: T[] }` envelope. */
export function listMyWebinarRegistrations(): Promise<{ data: WebinarRegistration[] }> {
  return apiFetch('/webinars/mine/registrations');
}

/* --------------------------- finance depth ----------------------------- */

export function fetchCreditScore(userId: string): Promise<{ data: CreditScoreResult }> {
  return apiFetch(`/finance/credit-score/${encodeURIComponent(userId)}`);
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listLenders(): Promise<{ data: Lender[] }> {
  return apiFetch('/finance/lenders');
}

export interface LenderRanking {
  lender: Lender;
  eligible: boolean;
  matchScore: number;
  reason: string;
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function fetchLenderMatches(userId: string): Promise<{ data: LenderRanking[] }> {
  return apiFetch(`/finance/lenders/match/${encodeURIComponent(userId)}`);
}

export function applyForLoan(
  input: {
    applicantId: string;
    lenderId: string;
    amountKobo: number;
    termMonths: number;
    annualRateBps: number;
    purpose?: string;
  },
  idempotencyKey?: string
): Promise<{ data: LoanApplication }> {
  return apiFetch('/finance/loans', { method: 'POST', body: input, idempotencyKey });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listLoans(params: {
  applicantId?: string;
  lenderId?: string;
  status?: string;
}): Promise<{ data: LoanApplication[] }> {
  return apiFetch('/finance/loans', { query: { ...params } });
}

export function fetchLoan(id: string): Promise<{ data: LoanApplication }> {
  return apiFetch(`/finance/loans/${encodeURIComponent(id)}`);
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function fetchLoanSchedule(loanId: string): Promise<{ data: RepaymentInstallment[] }> {
  return apiFetch(`/finance/loans/${encodeURIComponent(loanId)}/schedule`);
}

export function payLoanInstallment(
  loanId: string,
  sequence: number,
  idempotencyKey?: string
): Promise<{ data: RepaymentInstallment }> {
  return apiFetch(
    `/finance/loans/${encodeURIComponent(loanId)}/installments/${sequence}/pay`,
    { method: 'POST', idempotencyKey }
  );
}

/* -------------------------- marketplace depth -------------------------- */

export function fetchOrderEscrow(orderId: string): Promise<{ data: EscrowRecord | null }> {
  return apiFetch(`/orders/${encodeURIComponent(orderId)}/escrow`);
}

export function holdOrderEscrow(orderId: string): Promise<{ data: EscrowRecord }> {
  return apiFetch(`/orders/${encodeURIComponent(orderId)}/escrow`, { method: 'POST' });
}

export function fetchOrderShipment(orderId: string): Promise<{ data: Shipment | null }> {
  return apiFetch(`/orders/${encodeURIComponent(orderId)}/shipment`);
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listInvoices(params: {
  sellerId?: string;
  buyerId?: string;
  status?: string;
}): Promise<{ data: Invoice[] }> {
  return apiFetch('/invoices', { query: { ...params } });
}

export function fetchInvoice(id: string): Promise<{ data: Invoice }> {
  return apiFetch(`/invoices/${encodeURIComponent(id)}`);
}

/* --------------------------- chapter attendance ------------------------ */

export interface AttendanceCodeInfo {
  code: string;
  eventId: string;
  window: number;
  issuedAt: string;
  expiresAt: string;
}

/** Chapter leads and admins only (403 otherwise). */
export function fetchEventAttendanceCode(eventId: string): Promise<{ data: AttendanceCodeInfo }> {
  return apiFetch(`/events/${encodeURIComponent(eventId)}/attendance-code`);
}

/**
 * Scan check-in. Duplicate scans return 409 (ConflictError) — callers must
 * render that case gracefully ("already checked in").
 */
export function scanEventAttendance(
  eventId: string,
  input: { code: string; memberId?: string },
  idempotencyKey?: string
): Promise<{ data: unknown }> {
  return apiFetch(`/events/${encodeURIComponent(eventId)}/attendance/scan`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

/* ------------------------------ search depth --------------------------- */

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function fetchTrendingQueries(params: {
  limit?: number;
} = {}): Promise<{ data: TrendingQuery[] }> {
  return apiFetch('/search/trending', { query: { ...params } });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function fetchRelatedItems(params: {
  type: SearchResult['type'];
  id: string;
  limit?: number;
}): Promise<{ data: SearchResult[] }> {
  return apiFetch('/search/related', { query: { ...params } });
}
