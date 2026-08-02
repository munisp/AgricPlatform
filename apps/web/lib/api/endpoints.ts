import type {
  AdvisoryItem,
  AggregationPoint,
  Animal,
  AnimalGrade,
  AnimalHealthRecord,
  AnimalMovement,
  AnimalSex,
  AnimalStatus,
  ApiListResponse,
  AuditEvent,
  BookingStatus,
  CampusClub,
  CampusClubMembership,
  Certificate,
  CertifiedListing,
  Chapter,
  ChapterEvent,
  CohortThread,
  CohortThreadPost,
  ColdChainLog,
  ConsentRecord,
  Course,
  CreditProfile,
  CreditScoreResult,
  DiseaseFlag,
  DiseaseFlagStatus,
  DiseaseMapEntry,
  DonorDisbursement,
  DisbursementMilestone,
  Enrolment,
  EscrowRecord,
  ExportDocument,
  ExportDocumentType,
  ForumTopic,
  HealthRecordType,
  InstallmentStatus,
  InsuranceClaim,
  InsurancePolicy,
  IntegrationStatus,
  Invoice,
  KnowledgeFormat,
  KnowledgeResource,
  LanguageCode,
  LeaderboardEntry,
  Lender,
  LivestockLien,
  LivestockLot,
  LivestockRecall,
  LivestockSpecies,
  LivestockSubjectType,
  LoanApplication,
  MarketplaceListing,
  BuyerGroup,
  DraftOrder,
  ListingVariant,
  OrderExtension,
  PriceList,
  ProductReview,
  Promotion,
  ReturnRequest,
  ReturnStatus,
  SalesChannel,
  SellerAnalytics,
  SellerRating,
  MentorRequest,
  MilestoneProgress,
  MilestoneProgressStatus,
  MovementPermit,
  MovementPurpose,
  MovementTransportMode,
  NotificationMessage,
  NotificationPreference,
  OfftakeContract,
  OfftakeContractStatus,
  OfftakeTemplate,
  Opportunity,
  OpportunityApplication,
  Order,
  OwnershipTransfer,
  OwnershipTransferType,
  PastoralistProfile,
  PathwayEnrolment,
  PathwayStage,
  PathwayTemplate,
  PathwayTrack,
  PermitSubject,
  PermitVerification,
  PlatformMetric,
  PodcastEpisode,
  Profile,
  ProgrammeCohort,
  ProgrammeEnrolment,
  ProgrammeMilestone,
  ProgrammeType,
  RecallAnimal,
  RecallStatus,
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
import { apiFetch, apiUrl, type AuthIdentity } from './client';

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

/* --------------------------- recommendations --------------------------- */

export const RECOMMENDATION_TYPES = ['course', 'opportunity', 'listing', 'knowledge'] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export const RECOMMENDATION_REASONS = [
  'same_crop',
  'state_match',
  'lga_match',
  'value_chain_match',
  'category_affinity',
  'purchased_category',
  'completed_prerequisite',
  'trending_fallback'
] as const;
export type RecommendationReason = (typeof RECOMMENDATION_REASONS)[number];

/** Mirrors ScoredRecommendation in apps/api/src/modules/search/recommender.ts. */
export interface RecommendedItem {
  type: RecommendationType;
  id: string;
  title: string;
  summary: string;
  score: number;
  reasons: RecommendationReason[];
}

export type RecommendationFeedbackAction = 'clicked' | 'dismissed';

/** Authenticated. Plain `{ data: T[] }` envelope. */
export function fetchRecommendations(params: {
  limit?: number;
} = {}): Promise<{ data: RecommendedItem[] }> {
  return apiFetch('/recommendations', { query: { ...params } });
}

/** Authenticated. Feedback adjusts future ranking; response data is { recorded: true }. */
export function sendRecommendationFeedback(
  id: string,
  input: { type: RecommendationType; action: RecommendationFeedbackAction }
): Promise<{ data: unknown }> {
  return apiFetch(`/recommendations/${encodeURIComponent(id)}/feedback`, {
    method: 'POST',
    body: input
  });
}

/* ---------------------------- analytics depth -------------------------- */

export const SEGMENT_DIMENSIONS = ['state', 'crop', 'role', 'kyc_tier', 'cohort'] as const;
export type SegmentDimension = (typeof SEGMENT_DIMENSIONS)[number];

export interface SegmentBreakdown {
  key: string;
  count: number;
  percentage: number;
}

export interface SegmentationResult {
  dimension: SegmentDimension;
  total: number;
  segments: SegmentBreakdown[];
}

export interface FunnelStep {
  key: string;
  count: number;
  conversionFromPrevious: number | null;
  conversionFromFirst: number;
}

export interface ChapterOpsFunnel {
  events: number;
  rsvps: number;
  attendances: number;
  rsvpPerEvent: number;
  attendanceRate: number;
}

export interface CohortRetentionRow {
  cohortWeek: string;
  size: number;
  retention: (number | null)[];
  retained: (number | null)[];
}

export interface RetentionMatrix {
  timezone: 'Africa/Lagos';
  currentWeek: string;
  maxWeeks: number;
  rows: CohortRetentionRow[];
}

export const MART_NAMES = ['member_kpis', 'marketplace', 'learning'] as const;
export type MartName = (typeof MART_NAMES)[number];

/** Row counts persisted by the snapshot job, keyed by mart. */
export interface MartSnapshot {
  memberKpis: unknown;
  marketplace: unknown;
  learning: unknown;
}

/** Admin only. */
export function fetchSegmentation(by: SegmentDimension): Promise<{ data: SegmentationResult }> {
  return apiFetch('/analytics/segmentation', { query: { by } });
}

/** Admin only. */
export function fetchMemberFunnel(params: {
  windowDays?: number;
} = {}): Promise<{ data: FunnelStep[] }> {
  return apiFetch('/analytics/funnel', { query: { ...params } });
}

/** Admin only. */
export function fetchChapterFunnel(): Promise<{ data: ChapterOpsFunnel }> {
  return apiFetch('/analytics/funnel/chapters');
}

/** Admin only. */
export function fetchRetention(params: { weeks?: number } = {}): Promise<{ data: RetentionMatrix }> {
  return apiFetch('/analytics/retention', { query: { ...params } });
}

/** Admin only. Recomputes and upserts all KPI marts for one Lagos calendar day. */
export function snapshotMarts(params: { date?: string } = {}): Promise<{ data: MartSnapshot }> {
  return apiFetch('/analytics/marts/snapshot', { method: 'POST', query: { ...params } });
}

/* ------------------------- federation (phase 3) ------------------------ */

export type ExternalSystem = 'farmos' | 'litefarm';

export interface ExternalAccountLink {
  id: string;
  userId: string;
  system: ExternalSystem;
  externalId: string;
  consentAt: string;
  revokedAt?: string;
  createdAt: string;
}

export type FarmRecordType = 'crop_plan' | 'harvest' | 'field_map';

export interface FarmRecord {
  id: string;
  linkId: string;
  recordType: FarmRecordType;
  externalId: string;
  payload: Record<string, unknown>;
  source: string;
  observedAt: string;
  syncedAt: string;
}

export type ImportBatchStatus = 'STAGED' | 'CONFIRMED';

export interface ImportBatch {
  id: string;
  sourceSystem: string;
  donorSource: string;
  status: ImportBatchStatus;
  recordCount: number;
  createdBy: string;
  createdAt: string;
  confirmedAt?: string;
  confirmedBy?: string;
}

export type ImportRecordStatus = 'STAGED' | 'MERGED' | 'REJECTED';

export interface ImportRecord {
  id: string;
  batchId: string;
  ninHash?: string;
  phoneHash?: string;
  payload: Record<string, unknown>;
  status: ImportRecordStatus;
  donorSource: string;
  consentDate: string;
  matchedUserId?: string;
  createdAt: string;
}

export interface ImportBatchDetail {
  batch: ImportBatch;
  records: ImportRecord[];
}

export interface ImportConfirmResult {
  batch: ImportBatch;
  merged: number;
  rejected: number;
}

/** Authenticated; caller's own links. Plain `{ data: T[] }` envelope. */
export function listExternalAccountLinks(): Promise<{ data: ExternalAccountLink[] }> {
  return apiFetch('/integrations/federation/links');
}

/** Authenticated; soft-revokes (unlinks) one of the caller's external accounts. */
export function revokeExternalAccountLink(id: string): Promise<{ data: ExternalAccountLink }> {
  return apiFetch(`/integrations/federation/links/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
}

/** Authenticated; normalised farm records across the caller's links. Plain `{ data: T[] }`. */
export function listMyFarmRecords(): Promise<{ data: FarmRecord[] }> {
  return apiFetch('/integrations/federation/farm-records');
}

/** Authenticated; admins may pass userId to sync a member's links. */
export function syncFarmRecords(params: {
  userId?: string;
} = {}): Promise<{ data: { syncedLinks: number; inserted: number } }> {
  return apiFetch('/integrations/federation/farm-records/sync', {
    method: 'POST',
    body: params.userId ? { userId: params.userId } : {}
  });
}

/** Admin only. */
export function fetchImportBatch(id: string): Promise<{ data: ImportBatchDetail }> {
  return apiFetch(`/integrations/federation/import/batches/${encodeURIComponent(id)}`);
}

/** Admin only. Confirm-and-merge a staged batch; returns a summary. */
export function confirmImportBatch(id: string): Promise<{ data: ImportConfirmResult }> {
  return apiFetch(`/integrations/federation/import/batches/${encodeURIComponent(id)}/confirm`, {
    method: 'POST'
  });
}

/** Admin only. Pull submissions from configured field-data sources into new batches. */
export function pullBeneficiaryImport(input: {
  donorSource: string;
}): Promise<{ data: { batchIds: string[] } }> {
  return apiFetch('/integrations/federation/import/pull', { method: 'POST', body: input });
}

/* ========================================================================
 * ALTP livestock platform (waves L1a–L1c).
 * Mirrors apps/api/src/modules/livestock, livestock-health and
 * livestock-trade (trade/finance/partners/compliance controllers).
 * All list endpoints here return a plain `{ data: T[] }` envelope.
 * ====================================================================== */

/* ------------------------- livestock registry -------------------------- */

export interface LivestockEnrolmentResult {
  userId: string;
  /** True when the farmer role marker had to be added by this call. */
  roleBound: boolean;
  consentId: string;
  alreadyEnrolled: boolean;
}

/** Enrol into the livestock domain (binds farmer marker + livestock_records consent). */
export function enrolLivestock(
  userId: string,
  idempotencyKey?: string
): Promise<{ data: LivestockEnrolmentResult }> {
  return apiFetch('/livestock/enrol', { method: 'POST', body: { userId }, idempotencyKey });
}

export interface RegisterAnimalInput {
  species: LivestockSpecies;
  breed: string;
  sex: AnimalSex;
  birthDate?: string;
  tagId?: string;
  eid?: string;
  /** Nigerian state name (e.g. 'Kaduna'); the issued ID embeds the two-letter code. */
  state: string;
  lga?: string;
  sireId?: string;
  damId?: string;
  notes?: string;
}

export function registerAnimal(
  input: RegisterAnimalInput,
  idempotencyKey?: string
): Promise<{ data: Animal }> {
  return apiFetch('/livestock/animals', { method: 'POST', body: input, idempotencyKey });
}

/** Caller's own animals. Plain `{ data: T[] }` envelope. */
export function listMyAnimals(params: {
  species?: LivestockSpecies;
  status?: AnimalStatus;
  state?: string;
} = {}): Promise<{ data: Animal[] }> {
  return apiFetch('/livestock/animals/mine', { query: { ...params } });
}

export function fetchAnimal(id: string): Promise<{ data: Animal }> {
  return apiFetch(`/livestock/animals/${encodeURIComponent(id)}`);
}

export function updateAnimal(
  id: string,
  patch: { breed?: string; notes?: string; eid?: string; status?: AnimalStatus }
): Promise<{ data: Animal }> {
  return apiFetch(`/livestock/animals/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch
  });
}

export function transferAnimal(
  id: string,
  input: { toUserId: string; transferType: OwnershipTransferType; effectiveAt?: string },
  idempotencyKey?: string
): Promise<{ data: OwnershipTransfer }> {
  return apiFetch(`/livestock/animals/${encodeURIComponent(id)}/transfer`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

/** Plain `{ data: T[] }` envelope. */
export function listAnimalTransfers(id: string): Promise<{ data: OwnershipTransfer[] }> {
  return apiFetch(`/livestock/animals/${encodeURIComponent(id)}/transfers`);
}

export function createLot(
  input: {
    species: LivestockSpecies;
    quantity: number;
    state: string;
    lga?: string;
    formationRule?: string;
  },
  idempotencyKey?: string
): Promise<{ data: LivestockLot }> {
  return apiFetch('/livestock/lots', { method: 'POST', body: input, idempotencyKey });
}

/** Plain `{ data: T[] }` envelope. */
export function listMyLots(): Promise<{ data: LivestockLot[] }> {
  return apiFetch('/livestock/lots/mine');
}

/** Lot detail including member animal IDs. */
export type LotWithAnimals = LivestockLot & { animalIds: string[] };

export function fetchLot(id: string): Promise<{ data: LotWithAnimals }> {
  return apiFetch(`/livestock/lots/${encodeURIComponent(id)}`);
}

export function setLotAnimals(
  id: string,
  input: { add?: string[]; remove?: string[] }
): Promise<{ data: LotWithAnimals }> {
  return apiFetch(`/livestock/lots/${encodeURIComponent(id)}/animals`, {
    method: 'PUT',
    body: input
  });
}

export function fetchMyPastoralistProfile(): Promise<{ data: PastoralistProfile }> {
  return apiFetch('/livestock/pastoralist-profile');
}

export function upsertPastoralistProfile(input: {
  grazingZoneId?: string;
  migrationPattern?: string;
  primarySpecies: LivestockSpecies[];
}): Promise<{ data: PastoralistProfile }> {
  return apiFetch('/livestock/pastoralist-profile', { method: 'PUT', body: input });
}

/* --------------------------- livestock health -------------------------- */

export interface RecordHealthInput {
  animalId: string;
  recordType: HealthRecordType;
  product: string;
  batchNumber: string;
  dose: string;
  administeredAt: string;
  withdrawalUntil?: string;
  notes?: string;
}

/** Append a vet-signed vaccination/treatment record (vet role). */
export function recordHealth(
  input: RecordHealthInput,
  idempotencyKey?: string
): Promise<{ data: AnimalHealthRecord }> {
  return apiFetch('/livestock-health/records', { method: 'POST', body: input, idempotencyKey });
}

/** Append a reversing entry that annuls a health record (original never mutated). */
export function reverseHealthRecord(
  id: string,
  notes?: string
): Promise<{ data: AnimalHealthRecord }> {
  return apiFetch(`/livestock-health/records/${encodeURIComponent(id)}/reverse`, {
    method: 'POST',
    body: notes ? { notes } : {}
  });
}

export interface HealthRecordVerification {
  recordId: string;
  ok: boolean;
  reason?: 'signature';
  reversed: boolean;
  reversalOfId?: string;
}

/** Recompute the HMAC signature over a health record (tamper detection). */
export function verifyHealthRecord(id: string): Promise<{ data: HealthRecordVerification }> {
  return apiFetch(`/livestock-health/records/${encodeURIComponent(id)}/verify`);
}

/** Append-only health ledger for an animal. Plain `{ data: T[] }` envelope. */
export function listAnimalHealthRecords(
  animalId: string
): Promise<{ data: AnimalHealthRecord[] }> {
  return apiFetch(`/livestock-health/animals/${encodeURIComponent(animalId)}/records`);
}

export interface StartMovementInput {
  animalId?: string;
  lotId?: string;
  fromState: string;
  fromLga?: string;
  toState: string;
  toLga?: string;
  departedAt?: string;
  transportMode: MovementTransportMode;
  purpose: MovementPurpose;
  permitId?: string;
}

export function startMovement(
  input: StartMovementInput,
  idempotencyKey?: string
): Promise<{ data: AnimalMovement }> {
  return apiFetch('/livestock-health/movements', { method: 'POST', body: input, idempotencyKey });
}

export function recordMovementArrival(
  id: string,
  arrivedAt?: string
): Promise<{ data: AnimalMovement }> {
  return apiFetch(`/livestock-health/movements/${encodeURIComponent(id)}/arrive`, {
    method: 'POST',
    body: arrivedAt ? { arrivedAt } : {}
  });
}

/** Plain `{ data: T[] }` envelope. */
export function listAnimalMovements(animalId: string): Promise<{ data: AnimalMovement[] }> {
  return apiFetch(`/livestock-health/animals/${encodeURIComponent(animalId)}/movements`);
}

/** Plain `{ data: T[] }` envelope. */
export function listLotMovements(lotId: string): Promise<{ data: AnimalMovement[] }> {
  return apiFetch(`/livestock-health/lots/${encodeURIComponent(lotId)}/movements`);
}

/** Issue a state movement permit covering animals and/or lots (vet or regulator). */
export function issueMovementPermit(
  input: {
    animalIds?: string[];
    lotIds?: string[];
    fromState: string;
    toState: string;
    validFrom: string;
    validUntil: string;
  },
  idempotencyKey?: string
): Promise<{ data: MovementPermit }> {
  return apiFetch('/livestock-health/permits', { method: 'POST', body: input, idempotencyKey });
}

export interface PermitVerificationResult {
  permit: MovementPermit;
  subjects: PermitSubject[];
  verification: PermitVerification;
}

/** Verify a permit by id or permit number. */
export function verifyMovementPermit(
  idOrNumber: string
): Promise<{ data: PermitVerificationResult }> {
  return apiFetch(`/livestock-health/permits/${encodeURIComponent(idOrNumber)}/verify`);
}

export function revokeMovementPermit(
  id: string,
  reason: string
): Promise<{ data: MovementPermit }> {
  return apiFetch(`/livestock-health/permits/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    body: { reason }
  });
}

export interface InitiateRecallInput {
  animalId?: string;
  lotId?: string;
  ownerUserId?: string;
  state?: string;
  fromDate?: string;
  toDate?: string;
  batchNumber?: string;
  reason: string;
}

export interface RecallWithAnimals {
  recall: LivestockRecall;
  animals: RecallAnimal[];
}

/** Initiate a recall scoped by animal, lot, owner or state+date range (regulator/admin). */
export function initiateRecall(
  input: InitiateRecallInput,
  idempotencyKey?: string
): Promise<{ data: RecallWithAnimals }> {
  return apiFetch('/livestock-health/recalls', { method: 'POST', body: input, idempotencyKey });
}

/** Regulator/admin. Plain `{ data: T[] }` envelope. */
export function listRecalls(params: {
  status?: RecallStatus;
} = {}): Promise<{ data: LivestockRecall[] }> {
  return apiFetch('/livestock-health/recalls', { query: { ...params } });
}

export function fetchRecall(id: string): Promise<{ data: RecallWithAnimals }> {
  return apiFetch(`/livestock-health/recalls/${encodeURIComponent(id)}`);
}

export function resolveRecall(id: string): Promise<{ data: LivestockRecall }> {
  return apiFetch(`/livestock-health/recalls/${encodeURIComponent(id)}/resolve`, {
    method: 'POST'
  });
}

/** Report a suspected disease outbreak flag (any authenticated user). */
export function reportDiseaseFlag(input: {
  disease: string;
  state: string;
  lga?: string;
  suspectedSpecies?: LivestockSpecies;
}): Promise<{ data: DiseaseFlag }> {
  return apiFetch('/livestock-health/disease-flags', { method: 'POST', body: input });
}

/** Confirm a reported flag (vet/regulator/admin). */
export function confirmDiseaseFlag(id: string): Promise<{ data: DiseaseFlag }> {
  return apiFetch(`/livestock-health/disease-flags/${encodeURIComponent(id)}/confirm`, {
    method: 'POST'
  });
}

/** Retract a flag as a false positive with a mandatory reason. */
export function retractDiseaseFlag(id: string, reason: string): Promise<{ data: DiseaseFlag }> {
  return apiFetch(`/livestock-health/disease-flags/${encodeURIComponent(id)}/retract`, {
    method: 'POST',
    body: { reason }
  });
}

/** Plain `{ data: T[] }` envelope. */
export function listDiseaseFlags(params: {
  status?: DiseaseFlagStatus;
  state?: string;
} = {}): Promise<{ data: DiseaseFlag[] }> {
  return apiFetch('/livestock-health/disease-flags', { query: { ...params } });
}

/** State-level disease map: confirmed flags grouped by state and disease. Plain `{ data: T[] }`. */
export function fetchDiseaseMap(params: {
  state?: string;
} = {}): Promise<{ data: DiseaseMapEntry[] }> {
  return apiFetch('/livestock-health/disease-map', { query: { ...params } });
}

export interface GradeComponents {
  /** Fraction of the species vaccination schedule covered (0..1). */
  vaccinationCoverage: number;
  vaccinationPoints: number;
  treatmentPoints: number;
  movementPoints: number;
  agePoints: number;
  movementCount: number;
  requiredVaccinations: readonly string[];
  completedVaccinations: string[];
}

export interface AnimalGradeResult {
  animalId: string;
  species: LivestockSpecies;
  grade: AnimalGrade;
  score: number;
  components: GradeComponents;
  computedAt: string;
}

/** Deterministic trust grade (A–D) for an animal. */
export function fetchAnimalGrade(animalId: string): Promise<{ data: AnimalGradeResult }> {
  return apiFetch(`/livestock-health/animals/${encodeURIComponent(animalId)}/grade`);
}

/* --------------------------- livestock trade --------------------------- */

/** Create a certified listing from an owned animal/lot (provenance snapshot captured). */
export function createCertifiedListing(
  input: { subjectType: LivestockSubjectType; subjectId: string; askingPriceKobo?: number },
  idempotencyKey?: string
): Promise<{ data: CertifiedListing }> {
  return apiFetch('/livestock-trade/listings', { method: 'POST', body: input, idempotencyKey });
}

/** Plain `{ data: T[] }` envelope. */
export function listMyCertifiedListings(): Promise<{ data: CertifiedListing[] }> {
  return apiFetch('/livestock-trade/listings/mine');
}

/** Active listings are discoverable; other states are owner/admin only. */
export function fetchCertifiedListing(id: string): Promise<{ data: CertifiedListing }> {
  return apiFetch(`/livestock-trade/listings/${encodeURIComponent(id)}`);
}

export function activateCertifiedListing(id: string): Promise<{ data: CertifiedListing }> {
  return apiFetch(`/livestock-trade/listings/${encodeURIComponent(id)}/activate`, {
    method: 'POST'
  });
}

export function markCertifiedListingSold(id: string): Promise<{ data: CertifiedListing }> {
  return apiFetch(`/livestock-trade/listings/${encodeURIComponent(id)}/sold`, { method: 'POST' });
}

export function withdrawCertifiedListing(id: string): Promise<{ data: CertifiedListing }> {
  return apiFetch(`/livestock-trade/listings/${encodeURIComponent(id)}/withdraw`, {
    method: 'POST'
  });
}

/** Admin only — revoke certification (e.g. provenance fraud). */
export function revokeCertifiedListing(
  id: string,
  reason: string
): Promise<{ data: CertifiedListing }> {
  return apiFetch(`/livestock-trade/listings/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    body: { reason }
  });
}

/** Partner/admin-managed contract template. */
export function createOfftakeTemplate(
  input: {
    name: string;
    description?: string;
    species: LivestockSpecies;
    defaultQuantity?: number;
    defaultPricePerUnitKobo?: number;
    deliveryWindowDays: number;
    defaultQualityGrade?: string;
  },
  idempotencyKey?: string
): Promise<{ data: OfftakeTemplate }> {
  return apiFetch('/livestock-trade/offtake-templates', {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

/** Plain `{ data: T[] }` envelope. */
export function listOfftakeTemplates(params: {
  status?: 'active' | 'archived';
} = {}): Promise<{ data: OfftakeTemplate[] }> {
  return apiFetch('/livestock-trade/offtake-templates', { query: { ...params } });
}

export function updateOfftakeTemplate(
  id: string,
  patch: {
    name?: string;
    description?: string;
    defaultQuantity?: number;
    defaultPricePerUnitKobo?: number;
    deliveryWindowDays?: number;
    defaultQualityGrade?: string;
  }
): Promise<{ data: OfftakeTemplate }> {
  return apiFetch(`/livestock-trade/offtake-templates/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch
  });
}

export function archiveOfftakeTemplate(id: string): Promise<{ data: OfftakeTemplate }> {
  return apiFetch(`/livestock-trade/offtake-templates/${encodeURIComponent(id)}/archive`, {
    method: 'POST'
  });
}

/** Instantiate a contract from a template (variable slots may override defaults). */
export function instantiateOfftakeContract(
  templateId: string,
  input: {
    farmerUserId: string;
    buyerUserId: string;
    quantity?: number;
    pricePerUnitKobo?: number;
    deliveryWindowStart?: string;
    qualityGrade?: string;
  },
  idempotencyKey?: string
): Promise<{ data: OfftakeContract }> {
  return apiFetch(
    `/livestock-trade/offtake-templates/${encodeURIComponent(templateId)}/contracts`,
    { method: 'POST', body: input, idempotencyKey }
  );
}

/** Plain `{ data: T[] }` envelope. */
export function listMyOfftakeContracts(): Promise<{ data: OfftakeContract[] }> {
  return apiFetch('/livestock-trade/offtake-contracts/mine');
}

export function fetchOfftakeContract(id: string): Promise<{ data: OfftakeContract }> {
  return apiFetch(`/livestock-trade/offtake-contracts/${encodeURIComponent(id)}`);
}

export function transitionOfftakeContract(
  id: string,
  to: OfftakeContractStatus
): Promise<{ data: OfftakeContract }> {
  return apiFetch(`/livestock-trade/offtake-contracts/${encodeURIComponent(id)}/transition`, {
    method: 'POST',
    body: { to }
  });
}

/** Generate a DRAFT export document (AfCFTA/cross-border); payload is watermarked. */
export function generateExportDocument(
  input: {
    documentType: ExportDocumentType;
    subjectType: LivestockSubjectType;
    subjectId: string;
    destinationCountry?: string;
    hsCode?: string;
    sanitaryCertificateRef?: string;
  },
  idempotencyKey?: string
): Promise<{ data: ExportDocument }> {
  return apiFetch('/livestock-trade/export-documents', {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

/** Version list per (subjectType, subjectId). Plain `{ data: T[] }` envelope. */
export function listExportDocuments(params: {
  subjectType: LivestockSubjectType;
  subjectId: string;
}): Promise<{ data: ExportDocument[] }> {
  return apiFetch('/livestock-trade/export-documents', { query: { ...params } });
}

export function fetchExportDocument(id: string): Promise<{ data: ExportDocument }> {
  return apiFetch(`/livestock-trade/export-documents/${encodeURIComponent(id)}`);
}

/* -------------------------- livestock finance -------------------------- */

/** Register a lien over an animal/lot (lender). */
export function registerLien(
  input: {
    subjectType: LivestockSubjectType;
    subjectId: string;
    principalKobo: number;
    terms: string;
  },
  idempotencyKey?: string
): Promise<{ data: LivestockLien }> {
  return apiFetch('/livestock-finance/liens', { method: 'POST', body: input, idempotencyKey });
}

/** Caller's own registered liens (lender). Plain `{ data: T[] }` envelope. */
export function listMyLiens(): Promise<{ data: LivestockLien[] }> {
  return apiFetch('/livestock-finance/liens/mine');
}

/** Liens for a subject (owner, lender, admin). Plain `{ data: T[] }` envelope. */
export function listLiens(params: {
  subjectType: LivestockSubjectType;
  subjectId: string;
}): Promise<{ data: LivestockLien[] }> {
  return apiFetch('/livestock-finance/liens', { query: { ...params } });
}

export function dischargeLien(id: string): Promise<{ data: LivestockLien }> {
  return apiFetch(`/livestock-finance/liens/${encodeURIComponent(id)}/discharge`, {
    method: 'POST'
  });
}

export function defaultLien(id: string): Promise<{ data: LivestockLien }> {
  return apiFetch(`/livestock-finance/liens/${encodeURIComponent(id)}/default`, {
    method: 'POST'
  });
}

/** Quote → policy in `quote` status; bind to activate cover. */
export function quoteInsurancePolicy(
  input: {
    subjectType: LivestockSubjectType;
    subjectId: string;
    premiumKobo: number;
    coverageKobo: number;
    startsAt?: string;
    endsAt?: string;
  },
  idempotencyKey?: string
): Promise<{ data: InsurancePolicy }> {
  return apiFetch('/livestock-finance/insurance/quotes', {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

export function bindInsurancePolicy(id: string): Promise<{ data: InsurancePolicy }> {
  return apiFetch(`/livestock-finance/insurance/policies/${encodeURIComponent(id)}/bind`, {
    method: 'POST'
  });
}

export function lapseInsurancePolicy(id: string): Promise<{ data: InsurancePolicy }> {
  return apiFetch(`/livestock-finance/insurance/policies/${encodeURIComponent(id)}/lapse`, {
    method: 'POST'
  });
}

export function cancelInsurancePolicy(id: string): Promise<{ data: InsurancePolicy }> {
  return apiFetch(`/livestock-finance/insurance/policies/${encodeURIComponent(id)}/cancel`, {
    method: 'POST'
  });
}

/** Plain `{ data: T[] }` envelope. */
export function listMyInsurancePolicies(): Promise<{ data: InsurancePolicy[] }> {
  return apiFetch('/livestock-finance/insurance/policies/mine');
}

export function fetchInsurancePolicy(id: string): Promise<{ data: InsurancePolicy }> {
  return apiFetch(`/livestock-finance/insurance/policies/${encodeURIComponent(id)}`);
}

export function submitInsuranceClaim(
  input: { policyId: string; animalIds: string[]; amountKobo?: number; notes?: string },
  idempotencyKey?: string
): Promise<{ data: InsuranceClaim }> {
  return apiFetch('/livestock-finance/insurance/claims', {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

/** Plain `{ data: T[] }` envelope. */
export function listInsuranceClaims(policyId: string): Promise<{ data: InsuranceClaim[] }> {
  return apiFetch('/livestock-finance/insurance/claims', { query: { policyId } });
}

export function assessInsuranceClaim(
  id: string,
  input: { amountKobo?: number; notes?: string }
): Promise<{ data: InsuranceClaim }> {
  return apiFetch(`/livestock-finance/insurance/claims/${encodeURIComponent(id)}/assess`, {
    method: 'POST',
    body: input
  });
}

export function settleInsuranceClaim(
  id: string,
  outcome: 'paid' | 'rejected'
): Promise<{ data: InsuranceClaim }> {
  return apiFetch(`/livestock-finance/insurance/claims/${encodeURIComponent(id)}/settle`, {
    method: 'POST',
    body: { outcome }
  });
}

/** Schedule a milestone-based donor disbursement. */
export function scheduleDisbursement(
  input: {
    programmeId: string;
    milestone: DisbursementMilestone;
    amountKobo: number;
    beneficiaryUserId: string;
  },
  idempotencyKey?: string
): Promise<{ data: DonorDisbursement }> {
  return apiFetch('/livestock-finance/disbursements', {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

export function releaseDisbursement(id: string): Promise<{ data: DonorDisbursement }> {
  return apiFetch(`/livestock-finance/disbursements/${encodeURIComponent(id)}/release`, {
    method: 'POST'
  });
}

export function confirmDisbursement(id: string): Promise<{ data: DonorDisbursement }> {
  return apiFetch(`/livestock-finance/disbursements/${encodeURIComponent(id)}/confirm`, {
    method: 'POST'
  });
}

/** Donor's own disbursements. Plain `{ data: T[] }` envelope. */
export function listMyDisbursements(): Promise<{ data: DonorDisbursement[] }> {
  return apiFetch('/livestock-finance/disbursements/mine');
}

/** Plain `{ data: T[] }` envelope. */
export function listDisbursementsForBeneficiary(
  userId: string
): Promise<{ data: DonorDisbursement[] }> {
  return apiFetch(`/livestock-finance/disbursements/beneficiary/${encodeURIComponent(userId)}`);
}

/* ---------------------- livestock partners (F7) ------------------------ */

export function createAggregationPoint(
  input: { name: string; state: string; lga: string; capacity?: number },
  idempotencyKey?: string
): Promise<{ data: AggregationPoint }> {
  return apiFetch('/livestock-partners/aggregation-points', {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

/** Plain `{ data: T[] }` envelope. */
export function listAggregationPoints(params: {
  state?: string;
} = {}): Promise<{ data: AggregationPoint[] }> {
  return apiFetch('/livestock-partners/aggregation-points', { query: { ...params } });
}

/** Plain `{ data: T[] }` envelope. */
export function listMyAggregationPoints(): Promise<{ data: AggregationPoint[] }> {
  return apiFetch('/livestock-partners/aggregation-points/mine');
}

export function fetchAggregationPoint(id: string): Promise<{ data: AggregationPoint }> {
  return apiFetch(`/livestock-partners/aggregation-points/${encodeURIComponent(id)}`);
}

/** Assign a lot to an aggregation point (single-species enforced). */
export function assignLotToPoint(
  pointId: string,
  lotId: string
): Promise<{ data: AggregationPoint }> {
  return apiFetch(
    `/livestock-partners/aggregation-points/${encodeURIComponent(pointId)}/lots/${encodeURIComponent(lotId)}`,
    { method: 'POST' }
  );
}

export function unassignLotFromPoint(
  pointId: string,
  lotId: string
): Promise<{ data: AggregationPoint }> {
  return apiFetch(
    `/livestock-partners/aggregation-points/${encodeURIComponent(pointId)}/lots/${encodeURIComponent(lotId)}`,
    { method: 'DELETE' }
  );
}

export function deactivateAggregationPoint(id: string): Promise<{ data: AggregationPoint }> {
  return apiFetch(`/livestock-partners/aggregation-points/${encodeURIComponent(id)}/deactivate`, {
    method: 'POST'
  });
}

export function ingestColdChainReading(
  pointId: string,
  input: { recordedAt: string; temperatureCelsius: number; humidityPercent?: number }
): Promise<{ data: ColdChainLog }> {
  return apiFetch(
    `/livestock-partners/aggregation-points/${encodeURIComponent(pointId)}/cold-chain`,
    { method: 'POST', body: input }
  );
}

/* --------------------- Wave P: platform foundation --------------------- */

/** DB-backed feature flag (platform.feature_flags). */
export interface FeatureFlag {
  key: string;
  enabled: boolean;
  roleAllowlist: string[];
  percentage: number;
  description: string;
  updatedAt: string;
}

export interface FeatureFlagEvaluation {
  key: string;
  enabled: boolean;
}

export interface ModuleHealthProbe {
  name: string;
  status: 'up' | 'down' | 'disabled';
  details?: Record<string, unknown>;
  error?: string;
}

export interface ModuleHealthReport {
  status: 'ok' | 'degraded';
  checkedAt: string;
  modules: ModuleHealthProbe[];
}

export interface AuditVerificationResult {
  valid: boolean;
  brokenAt?: string;
  checked?: number;
}

export interface DeliveryQueueEntry {
  notificationId: string;
  attempt: number;
  lastResult: { delivered: boolean; provider: string; note: string };
  lastAttemptAt: string;
  nextRetryAt?: string;
  deadLetteredAt?: string;
}

export interface OutboxSweepSummary {
  published: number;
  failed: number;
  deadLettered: number;
  deferred: number;
}

export interface NotificationStreamPayload {
  unreadCount: number;
  notifications: NotificationMessage[];
  emittedAt: string;
}

/** Evaluate a feature flag for the current caller (fail-closed server-side). */
export function evaluateFeatureFlag(key: string): Promise<{ data: FeatureFlagEvaluation }> {
  return apiFetch(`/feature-flags/${encodeURIComponent(key)}/evaluate`);
}

export function adminListFeatureFlags(): Promise<{ data: FeatureFlag[] }> {
  return apiFetch('/feature-flags');
}

export function adminUpsertFeatureFlag(flag: {
  key: string;
  enabled: boolean;
  roleAllowlist?: string[];
  percentage: number;
  description?: string;
}): Promise<{ data: FeatureFlag }> {
  return apiFetch(`/feature-flags/${encodeURIComponent(flag.key)}`, {
    method: 'PUT',
    body: { roleAllowlist: [], description: '', ...flag }
  });
}

export function adminDeleteFeatureFlag(key: string): Promise<{ data: { key: string; removed: boolean } }> {
  return apiFetch(`/feature-flags/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

/** Per-module readiness matrix (cheap probes only). */
export function fetchModuleHealth(): Promise<ModuleHealthReport> {
  return apiFetch('/health/modules');
}

/** Tamper-evident audit chain verification over an optional id range. */
export function adminVerifyAuditLog(range?: {
  fromId?: string;
  toId?: string;
}): Promise<{ data: AuditVerificationResult }> {
  return apiFetch('/admin/audit-log/verify', { query: { ...range } });
}

export function adminSweepOutbox(): Promise<{ data: OutboxSweepSummary }> {
  return apiFetch('/admin/outbox/sweep', { method: 'POST' });
}

export function adminDeliveryDeadLetters(): Promise<{ data: DeliveryQueueEntry[] }> {
  return apiFetch('/notifications/deliveries/dead-letters');
}

export function adminSweepDeliveries(): Promise<{
  data: { retried: number; delivered: number; deadLettered: number; deferred: number };
}> {
  return apiFetch('/notifications/deliveries/sweep', { method: 'POST' });
}

export function adminRetryDelivery(
  notificationId: string
): Promise<{ data: DeliveryQueueEntry }> {
  return apiFetch(`/notifications/deliveries/${encodeURIComponent(notificationId)}/retry`, {
    method: 'POST'
  });
}

/**
 * SSE stream URL for the notification bell (EventSource cannot set headers,
 * so the identity travels as RFC 6750 query parameters — same verification
 * server-side). Returns null when no identity is available.
 */
export function notificationStreamUrl(identity: AuthIdentity | null): string | null {
  if (!identity?.token && !identity?.userId) {
    return null;
  }
  return apiUrl('/notifications/stream', {
    access_token: identity.token,
    'x-user-id': identity.token ? undefined : identity.userId
  });
}

/** Plain `{ data: T[] }` envelope. */
export function listColdChainReadings(pointId: string): Promise<{ data: ColdChainLog[] }> {
  return apiFetch(
    `/livestock-partners/aggregation-points/${encodeURIComponent(pointId)}/cold-chain`
  );
}

/* -------------------- Wave M: marketplace commerce ---------------------- */

export function listVariants(listingId: string): Promise<{ data: ListingVariant[] }> {
  return apiFetch(`/listings/${encodeURIComponent(listingId)}/variants`);
}

export function createVariant(
  listingId: string,
  input: { sku: string; name: string; attributes?: Record<string, string>; priceKobo: number; quantity: number },
  idempotencyKey?: string
): Promise<{ data: ListingVariant }> {
  return apiFetch(`/listings/${encodeURIComponent(listingId)}/variants`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

export function checkoutOrder(
  input: {
    listingId: string;
    variantId?: string;
    buyerId: string;
    quantity: number;
    promotionCode?: string;
    channel?: SalesChannel;
  },
  idempotencyKey?: string
): Promise<{ data: { order: Order; extension: OrderExtension } }> {
  return apiFetch('/checkout/orders', { method: 'POST', body: input, idempotencyKey });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listBuyerGroups(): Promise<{ data: BuyerGroup[] }> {
  return apiFetch('/buyer-groups');
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listPriceLists(): Promise<{ data: PriceList[] }> {
  return apiFetch('/price-lists');
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listPromotions(): Promise<{ data: Promotion[] }> {
  return apiFetch('/promotions');
}

export function createPromotion(
  input: {
    code?: string;
    name: string;
    kind: Promotion['kind'];
    value: number;
    automatic?: boolean;
    minOrderKobo?: number;
    listingId?: string;
    buyerGroupId?: string;
    usageLimit?: number;
    startsAt?: string;
    endsAt?: string;
  },
  idempotencyKey?: string
): Promise<{ data: Promotion }> {
  return apiFetch('/promotions', { method: 'POST', body: input, idempotencyKey });
}

export function editOrderQuantity(orderId: string, quantity: number): Promise<{ data: Order }> {
  return apiFetch(`/orders/${encodeURIComponent(orderId)}/edit`, {
    method: 'POST',
    body: { quantity }
  });
}

export function cancelOrderWithRestock(orderId: string): Promise<{ data: Order }> {
  return apiFetch(`/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' });
}

export function requestReturn(
  orderId: string,
  input: { buyerId: string; reason: string; restock?: boolean },
  idempotencyKey?: string
): Promise<{ data: ReturnRequest }> {
  return apiFetch(`/orders/${encodeURIComponent(orderId)}/returns`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listReturns(params: {
  orderId?: string;
  buyerId?: string;
  status?: ReturnStatus;
} = {}): Promise<{ data: ReturnRequest[] }> {
  return apiFetch('/returns', { query: { ...params } });
}

export function transitionReturn(id: string, status: ReturnStatus): Promise<{ data: ReturnRequest }> {
  return apiFetch(`/returns/${encodeURIComponent(id)}/transition`, {
    method: 'POST',
    body: { status }
  });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listDraftOrders(params: {
  buyerId?: string;
  sellerId?: string;
  status?: DraftOrder['status'];
} = {}): Promise<{ data: DraftOrder[] }> {
  return apiFetch('/draft-orders', { query: { ...params } });
}

export function confirmDraftOrder(id: string): Promise<{ data: { draft: DraftOrder; order: Order } }> {
  return apiFetch(`/draft-orders/${encodeURIComponent(id)}/confirm`, { method: 'POST' });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listListingReviews(listingId: string): Promise<{ data: ProductReview[] }> {
  return apiFetch(`/listings/${encodeURIComponent(listingId)}/reviews`);
}

export function createListingReview(
  listingId: string,
  input: { orderId: string; buyerId: string; rating: number; comment?: string },
  idempotencyKey?: string
): Promise<{ data: ProductReview }> {
  return apiFetch(`/listings/${encodeURIComponent(listingId)}/reviews`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

export function fetchSellerRating(userId: string): Promise<{ data: SellerRating }> {
  return apiFetch(`/sellers/${encodeURIComponent(userId)}/rating`);
}

export function fetchSellerAnalytics(sellerId: string): Promise<{ data: SellerAnalytics }> {
  return apiFetch(`/analytics/sellers/${encodeURIComponent(sellerId)}`);
}

/* ------------------ Wave B: analytics star marts (admin) ----------------- */

/** analytics.mart_daily_metrics row (Africa/Lagos calendar day). */
export interface DailyMetric {
  metricDate: string;
  ordersGmvKobo: number;
  ordersCount: number;
  activeFarmers: number;
  escrowHeldKobo: number;
  livestockRegistered: number;
}

/** Headline star-mart aggregates (GET /analytics/metrics/summary). */
export interface AnalyticsSummary {
  gmvKobo: number;
  ordersCount: number;
  escrowHeldKobo: number;
  livestockRegistered: number;
  members: number;
  listings: number;
  /** Projector heartbeat; null until the first projection run. */
  lastProjectionAt: string | null;
  generatedAt: string;
}

/** Result of one outbox→mart projection pass (POST /analytics/project). */
export interface ProjectionRun {
  scanned: number;
  applied: number;
  skipped: number;
  recomputedDates: string[];
  ranAt: string;
}

/** Fact tables offered as lakehouse-handoff CSV exports. */
export const STAR_FACTS = ['fact_orders', 'fact_payments'] as const;
export type StarFact = (typeof STAR_FACTS)[number];

/** Admin or regulator. Inclusive YYYY-MM-DD range. */
export function fetchDailyMetrics(
  params: { from?: string; to?: string } = {}
): Promise<{ data: DailyMetric[] }> {
  return apiFetch('/analytics/metrics/daily', { query: { ...params } });
}

/** Admin or regulator. */
export function fetchAnalyticsSummary(): Promise<{ data: AnalyticsSummary }> {
  return apiFetch('/analytics/metrics/summary');
}

/**
 * Admin only. Runs one projection pass; designed to be invoked by an
 * external scheduler — no in-process timer exists on the API.
 */
export function runProjection(): Promise<{ data: ProjectionRun }> {
  return apiFetch('/analytics/project', { method: 'POST' });
}
