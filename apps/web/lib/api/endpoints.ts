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
  CropPlanting,
  FarmExpense,
  FarmExpenseCategory,
  FarmPlot,
  FarmSummary,
  HarvestQualityGrade,
  HarvestRecord,
  HarvestUnit,
  PlantingStatus,
  SoilType,
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
  ParametricPayout,
  ParametricPolicy,
  ParametricProduct,
  ParametricQuote,
  ParametricTriggerEvent,
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
  VaccinationDueItem,
  VaultDocument,
  Webinar,
  WebinarRegistration,
  WebinarStatus,
  CreditCollateral,
  CreditGroup,
  CreditGroupMember,
  CreditGuarantor,
  CreditLoanApplication,
  CreditLoanProduct,
  CreditPortfolioReport,
  CreditRepayment,
  CreditSavingsAccount,
  CreditSavingsTransaction,
  CreditScoreAssessment,
  GeoCreditShadowScore
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

/** Roster row for the attendance recorder (GET /events/:id/roster). */
export interface EventRosterEntry {
  userId: string;
  fullName: string;
  status: 'rsvp' | 'attended';
}

/**
 * Real attendance roster (chapter leads/admins): members who RSVPed to the
 * event. Replaces the demo-roster fixture in the attendance recorder.
 */
export function listEventRoster(eventId: string): Promise<{ data: EventRosterEntry[] }> {
  return apiFetch(`/events/${encodeURIComponent(eventId)}/roster`);
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

/**
 * Computed due-vaccination schedule (wave MOB). Farmers see their own
 * animals; admin/vet/regulator see all or filter by ownerUserId. `days` is
 * the lookahead window separating 'due' from 'upcoming' (default 30).
 * Plain `{ data: T[] }` envelope.
 */
export function listDueVaccinations(
  params: { days?: number; ownerUserId?: string } = {}
): Promise<{ data: VaccinationDueItem[] }> {
  return apiFetch('/livestock-health/vaccinations/due', { query: { ...params } });
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

/** Buyer-safe public provenance summary (G18) — no PII, no auth required. */
export interface CertifiedProvenanceSummary {
  listingId: string;
  certificationStatus: CertifiedListing['status'];
  subjectType: CertifiedListing['subjectType'];
  species: string;
  breed?: string;
  quantity?: number;
  ownershipDepth: number;
  state?: string;
}

/** Public provenance summary for a certified listing (buyer-safe). */
export function fetchCertifiedProvenance(
  id: string
): Promise<{ data: CertifiedProvenanceSummary }> {
  return apiFetch(`/livestock-trade/certified-listings/${encodeURIComponent(id)}/provenance`);
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

/* ------------- Wave lakehouse-export: marts → object storage ------------- */

/** One exported parquet part-file (as listed in the run manifest). */
export interface LakehousePartFile {
  key: string;
  bytes: number;
  sha256: string;
}

/** Per-table export summary inside the run manifest. */
export interface LakehouseTableExport {
  table: string;
  rows: number;
  files: LakehousePartFile[];
}

/**
 * _manifest.json of one lakehouse export run — the real contract written to
 * object storage by POST /analytics/export.
 */
export interface LakehouseManifest {
  runId: string;
  runDate: string;
  bucket: string;
  prefix: string;
  format: 'parquet';
  startedAt: string;
  finishedAt: string;
  tables: LakehouseTableExport[];
  totalRows: number;
  totalBytes: number;
}

/** GET /analytics/export/last response payload. */
export interface LakehouseExportStatus {
  enabled: boolean;
  /** Present when enabled=false: why the exporter is off. */
  reason?: string;
  bucket?: string;
  prefix: string;
  manifest: LakehouseManifest | null;
}

/** Admin only. Honest disabled state when LAKEHOUSE_ENABLED=false. */
export function fetchLakehouseExportStatus(): Promise<{ data: LakehouseExportStatus }> {
  return apiFetch('/analytics/export/last');
}

/** Admin only. Triggers one export run; 503 when the exporter is disabled. */
export function runLakehouseExport(): Promise<{ data: LakehouseManifest }> {
  return apiFetch('/analytics/export', { method: 'POST' });
}

/* --------------------- compliance (Wave COMP, NDPA 2023) --------------------- */

/** Versioned consent record (compliance schema; distinct from legacy privacy consents). */
export interface ComplianceConsentRecord {
  id: string;
  userId: string;
  purpose: string;
  policyVersion: string;
  grantedAt: string;
  revokedAt?: string;
  source: string;
}

export type DataSubjectRequestType = 'export' | 'erasure';
export type DataSubjectRequestStatus = 'pending' | 'processing' | 'completed' | 'rejected';

export interface DataSubjectRequest {
  id: string;
  userId: string;
  type: DataSubjectRequestType;
  status: DataSubjectRequestStatus;
  requestedAt: string;
  completedAt?: string;
  resultRef?: string;
  note?: string;
}

/** NDPA s.37 export bundle; `omissions` lists categories the bundle does NOT cover. */
export interface DataSubjectExport {
  generatedAt: string;
  subject: unknown;
  profile: unknown;
  orders: { asBuyer: unknown[]; asSeller: unknown[] };
  listings: unknown[];
  livestock: unknown[];
  consents: { compliance: ComplianceConsentRecord[]; privacy: ConsentRecord[] };
  notifications: unknown[];
  omissions: Array<{ category: string; reason: string }>;
  coverageNotes: string[];
}

export function recordComplianceConsent(input: {
  purpose: string;
  policyVersion: string;
  source?: string;
}): Promise<{ data: ComplianceConsentRecord }> {
  return apiFetch('/compliance/consents', { method: 'POST', body: input });
}

export function revokeComplianceConsent(
  purpose: string
): Promise<{ data: ComplianceConsentRecord }> {
  return apiFetch(`/compliance/consents/${encodeURIComponent(purpose)}`, { method: 'DELETE' });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listMyComplianceConsents(): Promise<{ data: ComplianceConsentRecord[] }> {
  return apiFetch('/compliance/consents/mine');
}

/** Creates AND completes the export request synchronously; the bundle is in `export`. */
export function requestDataExport(): Promise<{
  data: { request: DataSubjectRequest; export: DataSubjectExport };
}> {
  return apiFetch('/compliance/dsr/export', { method: 'POST' });
}

/** Creates a PENDING erasure request — an admin must approve it before anonymisation runs. */
export function requestDataErasure(): Promise<{ data: DataSubjectRequest }> {
  return apiFetch('/compliance/dsr/erasure', { method: 'POST' });
}

/** Note: returns a plain `{ data: T[] }` envelope (no pagination). */
export function listMyDataSubjectRequests(): Promise<{ data: DataSubjectRequest[] }> {
  return apiFetch('/compliance/dsr/mine');
}

/* --------------------- sync protocol v1 (Wave SYNCSRV) -------------------- */
/* Contract: docs/sync-protocol.md. All operations are scoped to the caller. */

export type SyncPushOp = 'upsert' | 'delete';

export interface SyncPushItem {
  entity: string;
  entityId: string;
  clientMutationId: string;
  baseVersion: number;
  op: SyncPushOp;
  payload?: Record<string, unknown>;
}

export interface SyncPushItemResult {
  entity: string;
  entityId: string;
  clientMutationId: string;
  status: 'applied' | 'conflict' | 'error';
  newVersion?: number;
  serverVersion?: number;
  serverPayload?: unknown;
  error?: string;
}

export interface SyncPullItem {
  entityId: string;
  version: number;
  deleted: boolean;
  payload: unknown;
}

export interface SyncPullPage {
  entity: string;
  items: SyncPullItem[];
  /** Monotonic per (user, entity); pass back as `since` on the next pull. */
  cursor: number;
  hasMore: boolean;
}

export interface SyncStatusEntry {
  entity: string;
  serverMaxVersion: number;
  cursor: number;
}

/** Push a batch of offline mutations (1–200 items; outcomes are per item). */
export function syncPush(items: SyncPushItem[]): Promise<{ data: { results: SyncPushItemResult[] } }> {
  return apiFetch('/sync/push', { method: 'POST', body: { items } });
}

/** Pull caller-scoped changes since a cursor (version-ordered, tombstoned). */
export function syncPull(params: {
  entity: string;
  since?: number;
  limit?: number;
}): Promise<{ data: SyncPullPage }> {
  return apiFetch('/sync/pull', { query: { ...params } });
}

/** Per-entity server max version + recorded cursor for the caller. */
export function syncStatus(): Promise<{ data: SyncStatusEntry[] }> {
  return apiFetch('/sync/status');
}

/* ========================================================================
 * Farms & crop-production (farms wave).
 * Mirrors apps/api/src/modules/farms (farms.controller). All endpoints
 * return a plain `{ data: T }` envelope; mutations support Idempotency-Key.
 * ====================================================================== */

export interface CreateFarmPlotInput {
  name: string;
  state: string;
  lga: string;
  centroidLat: number;
  centroidLong: number;
  boundaryGeojson?: unknown;
  sizeHectares: number;
  soilType?: SoilType;
  clientId?: string;
}

export interface UpdateFarmPlotInput {
  name?: string;
  state?: string;
  lga?: string;
  centroidLat?: number;
  centroidLong?: number;
  boundaryGeojson?: unknown;
  sizeHectares?: number;
  soilType?: SoilType;
}

export function createFarmPlot(
  input: CreateFarmPlotInput,
  idempotencyKey?: string
): Promise<{ data: FarmPlot }> {
  return apiFetch('/farms/plots', { method: 'POST', body: input, idempotencyKey });
}

/** Owner-scoped on the server: non-admins only ever receive their own plots. */
export function listFarmPlots(params: {
  ownerUserId?: string;
  state?: string;
} = {}): Promise<{ data: FarmPlot[] }> {
  return apiFetch('/farms/plots', { query: { ...params } });
}

export function fetchFarmPlot(id: string): Promise<{ data: FarmPlot }> {
  return apiFetch(`/farms/plots/${encodeURIComponent(id)}`);
}

export function updateFarmPlot(
  id: string,
  patch: UpdateFarmPlotInput,
  idempotencyKey?: string
): Promise<{ data: FarmPlot }> {
  return apiFetch(`/farms/plots/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
    idempotencyKey
  });
}

export function removeFarmPlot(id: string): Promise<{ data: { removed: boolean } }> {
  return apiFetch(`/farms/plots/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface CreateCropPlantingInput {
  crop: string;
  variety?: string;
  season: string;
  plantedAt: string;
  expectedHarvestAt?: string;
  clientId?: string;
}

export function createCropPlanting(
  plotId: string,
  input: CreateCropPlantingInput,
  idempotencyKey?: string
): Promise<{ data: CropPlanting }> {
  return apiFetch(`/farms/plots/${encodeURIComponent(plotId)}/plantings`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

export function listCropPlantings(plotId: string): Promise<{ data: CropPlanting[] }> {
  return apiFetch(`/farms/plots/${encodeURIComponent(plotId)}/plantings`);
}

export function transitionCropPlanting(
  id: string,
  status: PlantingStatus,
  idempotencyKey?: string
): Promise<{ data: CropPlanting }> {
  return apiFetch(`/farms/plantings/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { status },
    idempotencyKey
  });
}

export interface RecordHarvestInput {
  harvestedAt: string;
  quantity: number;
  unit: HarvestUnit;
  qualityGrade?: HarvestQualityGrade;
}

export function recordHarvest(
  plantingId: string,
  input: RecordHarvestInput,
  idempotencyKey?: string
): Promise<{ data: HarvestRecord }> {
  return apiFetch(`/farms/plantings/${encodeURIComponent(plantingId)}/harvests`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

export function listHarvestRecords(plantingId: string): Promise<{ data: HarvestRecord[] }> {
  return apiFetch(`/farms/plantings/${encodeURIComponent(plantingId)}/harvests`);
}

export interface CreateFarmExpenseInput {
  category: FarmExpenseCategory;
  amountKobo: number;
  incurredAt: string;
  note?: string;
}

export function createFarmExpense(
  plotId: string,
  input: CreateFarmExpenseInput,
  idempotencyKey?: string
): Promise<{ data: FarmExpense }> {
  return apiFetch(`/farms/plots/${encodeURIComponent(plotId)}/expenses`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

export function listFarmExpenses(plotId: string): Promise<{ data: FarmExpense[] }> {
  return apiFetch(`/farms/plots/${encodeURIComponent(plotId)}/expenses`);
}

export function fetchFarmSummary(ownerUserId?: string): Promise<{ data: FarmSummary }> {
  return apiFetch('/farms/summary', { query: ownerUserId ? { ownerUserId } : {} });
}

/* --------------------- field agents (Wave AGENTS, enumerators) --------------------- */

export type AgentAssignmentStatus = 'assigned' | 'in_progress' | 'completed' | 'cancelled';

/** Unit of field work assigned to an enumerator (agents.agent_assignments). */
export interface AgentAssignment {
  id: string;
  agentUserId: string;
  farmerUserId?: string;
  chapterId?: string;
  state: string;
  lga: string;
  ward?: string;
  purpose: string;
  targetCount: number;
  completedCount: number;
  status: AgentAssignmentStatus;
  dueAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Per-agent productivity aggregate (GET /field-agents/productivity, admin). */
export interface AgentProductivity {
  agentUserId: string;
  totalAssignments: number;
  activeAssignments: number;
  completedAssignments: number;
  cancelledAssignments: number;
  targetCount: number;
  completedCount: number;
  /** completedCount / targetCount in [0, 1]; 0 when no target was set. */
  completionRate: number;
}

export interface CreateAgentAssignmentInput {
  agentUserId: string;
  farmerUserId?: string;
  chapterId?: string;
  state: string;
  lga: string;
  ward?: string;
  purpose: string;
  targetCount?: number;
  dueAt?: string;
}

/** Admin/chapter-lead creation. Plain `{ data: T }` envelope. */
export function createAgentAssignment(
  input: CreateAgentAssignmentInput
): Promise<{ data: AgentAssignment }> {
  return apiFetch('/field-agents/assignments', { method: 'POST', body: input });
}

/** Admin/chapter-lead listing (chapter leads are scoped server-side). */
export function listAgentAssignments(filter?: {
  agentUserId?: string;
  status?: AgentAssignmentStatus;
  state?: string;
  chapterId?: string;
}): Promise<{ data: AgentAssignment[] }> {
  const params = new URLSearchParams();
  if (filter?.agentUserId) params.set('agentUserId', filter.agentUserId);
  if (filter?.status) params.set('status', filter.status);
  if (filter?.state) params.set('state', filter.state);
  if (filter?.chapterId) params.set('chapterId', filter.chapterId);
  const query = params.toString();
  return apiFetch(`/field-agents/assignments${query ? `?${query}` : ''}`);
}

/** Enumerator's own open queue. Plain `{ data: T[] }` envelope. */
export function listMyAgentAssignments(): Promise<{ data: AgentAssignment[] }> {
  return apiFetch('/field-agents/assignments/mine');
}

/** Enumerator progress report; auto-completes server-side at the target. */
export function reportAgentAssignmentProgress(
  id: string,
  count = 1
): Promise<{ data: AgentAssignment }> {
  return apiFetch(`/field-agents/assignments/${encodeURIComponent(id)}/progress`, {
    method: 'POST',
    body: { count }
  });
}

export function cancelAgentAssignment(id: string): Promise<{ data: AgentAssignment }> {
  return apiFetch(`/field-agents/assignments/${encodeURIComponent(id)}/cancel`, {
    method: 'POST'
  });
}

/** Admin-only per-agent completion aggregates. */
export function fetchAgentProductivity(): Promise<{ data: AgentProductivity[] }> {
  return apiFetch('/field-agents/productivity');
}

export interface CaptureFarmerProfileInput {
  farmerUserId?: string;
  farmerPhone?: string;
  location?: { state: string; lga: string; ward?: string; latitude?: number; longitude?: number };
  farmingInterests?: string[];
  valueChains?: string[];
  bio?: string;
  farmSizeHectares?: number;
  yearsExperience?: number;
  policyVersion?: string;
}

export interface CaptureFarmerProfileResult {
  profile: unknown;
  farmerUserId: string;
  consentId: string;
  capturedBy: string;
}

/**
 * Enumerator on-behalf capture: upserts the farmer's profile and records a
 * 'field-data-capture' consent attributed to the agent.
 */
export function captureFarmerProfile(
  input: CaptureFarmerProfileInput
): Promise<{ data: CaptureFarmerProfileResult }> {
  return apiFetch('/field-agents/capture/profile', { method: 'POST', body: input });
}

/* ================================================================= * Geospatial pack (Wave GEO).
 * Mirrors apps/api/src/modules/geo (geo.controller). H3-based spatial
 * indexing computed on the API — no PostGIS. All endpoints return a plain
 * `{ data: T }` envelope.
 * ====================================================================== */

import type {
  GeoBoundary,
  GeoBoundaryKind,
  GeoCellBoundary,
  GeoClustersResult,
  GeoContainsResult,
  GeoFarmsNearResult,
  GeoReindexResult,
  H3Resolution
} from '@agric-platform/shared';

/** Admin-only H3 index rebuild (idempotent; reports per-entity counts). */
export function reindexGeo(): Promise<{ data: GeoReindexResult }> {
  return apiFetch('/geo/reindex', { method: 'POST' });
}

/**
 * Farms inside the k-ring around (lat, long). Owner-scoped server-side:
 * non-managers only ever receive their own plots.
 */
export function fetchFarmsNear(params: {
  lat: number;
  long: number;
  res?: H3Resolution;
  ring?: number;
}): Promise<{ data: GeoFarmsNearResult }> {
  return apiFetch('/geo/farms/near', { query: { ...params } });
}

/** Manager-only per-cell farm counts for cluster map rendering. */
export function fetchGeoClusters(res: H3Resolution = 5): Promise<{ data: GeoClustersResult }> {
  return apiFetch('/geo/farms/clusters', { query: { res } });
}

export function listGeoBoundaries(kind?: GeoBoundaryKind): Promise<{ data: GeoBoundary[] }> {
  return apiFetch('/geo/boundaries', { query: kind ? { kind } : {} });
}

export interface CreateGeoBoundaryInput {
  kind: GeoBoundaryKind;
  name: string;
  parentId?: string;
  boundaryGeojson: unknown;
}

/** Admin-only boundary registration. */
export function createGeoBoundary(
  input: CreateGeoBoundaryInput
): Promise<{ data: GeoBoundary }> {
  return apiFetch('/geo/boundaries', { method: 'POST', body: input });
}

/** H3 cell boundary as closed GeoJSON for map rendering. */
export function fetchGeoCell(h3: string): Promise<{ data: GeoCellBoundary }> {
  return apiFetch(`/geo/cells/${encodeURIComponent(h3)}`);
}

/**
 * Point-in-boundary check (ray casting server-side). Used by movement-permit
 * zone rules; accepts a stored boundaryId or an inline GeoJSON geometry.
 */
export function checkGeoContains(input: {
  lat: number;
  long: number;
  boundaryId?: string;
  geojson?: unknown;
}): Promise<{ data: GeoContainsResult }> {
  return apiFetch('/geo/contains', { method: 'POST', body: input });
}

/* ========================================================================
 * Geo-intel flood risk (wave ML, union-append).
 * Mirrors apps/api/src/modules/geo-intel (geo-intel.controller). The
 * flood-ml sidecar is OPTIONAL — `driver`/`liveInference` on the status
 * payload say honestly whether assessments are live model output or the
 * deterministic simulated fixture.
 * ====================================================================== */

export interface FloodRiskStatus {
  driver: 'stub' | 'http';
  configured: boolean;
  healthy: boolean;
  /** True only when assessments come from the real flood-ml sidecar. */
  liveInference: boolean;
  detail: string;
}

export interface FloodRiskAssessment {
  floodDetected: boolean;
  severity: string;
  floodPercentage: number;
  floodAreaKm2: number;
  confidence: number;
  source: string;
  assessedAt: string;
  message: string;
  recommendedActions: string[];
  assessedLocation: { latitude: number; longitude: number };
  driver: 'stub' | 'http';
  plot?: { id: string; name: string; distanceKm: number };
}

/** Honest driver/config status for the flood-risk integration. */
export function fetchFloodRiskStatus(): Promise<{ data: FloodRiskStatus }> {
  return apiFetch('/geo-intel/flood-risk/status');
}

/**
 * Flood-risk assessment. Without lat/long the API assesses the caller's own
 * farm plot (nearest/first with coordinates); with them it assesses the
 * point and attaches the nearest own plot when close by.
 */
export function fetchFloodRisk(params?: {
  lat?: number;
  long?: number;
}): Promise<{ data: FloodRiskAssessment }> {
  return apiFetch('/geo-intel/flood-risk', { query: { ...params } });
}

/* ------------------------------ credit suite ---------------------------- */
/* Wave CREDIT: microfinance (products, applications, repayments, groups,  */
/* savings, portfolio). Plain `{ data: T }` envelopes throughout.           */

export interface CreditGroupWithMembers {
  group: CreditGroup;
  members: CreditGroupMember[];
}

export interface SavingsTransactionResult {
  account: CreditSavingsAccount;
  transaction: CreditSavingsTransaction;
  replay: boolean;
}

/* -- products -- */

export function listCreditProducts(all = false): Promise<{ data: CreditLoanProduct[] }> {
  return apiFetch('/credit/products', { query: all ? { all: 'true' } : {} });
}

export function createCreditProduct(
  input: Omit<CreditLoanProduct, 'id' | 'createdAt'>,
  idempotencyKey?: string
): Promise<{ data: CreditLoanProduct }> {
  return apiFetch('/credit/products', { method: 'POST', body: input, idempotencyKey });
}

/* -- applications -- */

export function applyForCreditLoan(input: {
  productId: string;
  principalKobo: number;
  purpose?: string;
}): Promise<{ data: CreditLoanApplication }> {
  return apiFetch('/credit/applications', { method: 'POST', body: input });
}

export function applyForGroupCreditLoan(input: {
  productId: string;
  principalKobo: number;
  groupId: string;
  purpose?: string;
}): Promise<{ data: CreditLoanApplication }> {
  return apiFetch('/credit/applications/group', { method: 'POST', body: input });
}

export function listCreditLoans(params?: {
  status?: string;
  applicantUserId?: string;
  groupId?: string;
}): Promise<{ data: CreditLoanApplication[] }> {
  return apiFetch('/credit/applications', { query: { ...params } });
}

export function fetchCreditLoan(id: string): Promise<{ data: CreditLoanApplication }> {
  return apiFetch(`/credit/applications/${encodeURIComponent(id)}`);
}

function creditLoanAction(id: string, action: string): Promise<{ data: CreditLoanApplication }> {
  return apiFetch(`/credit/applications/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
}

export function submitCreditLoan(id: string) {
  return creditLoanAction(id, 'submit');
}
export function scoreCreditLoan(id: string) {
  return creditLoanAction(id, 'score');
}
export function approveCreditLoan(id: string) {
  return creditLoanAction(id, 'approve');
}
export function rejectCreditLoan(id: string) {
  return creditLoanAction(id, 'reject');
}
export function disburseCreditLoan(id: string) {
  return creditLoanAction(id, 'disburse');
}
export function startCreditRepayment(id: string) {
  return creditLoanAction(id, 'start-repayment');
}
export function defaultCreditLoan(id: string) {
  return creditLoanAction(id, 'default');
}

/* -- repayments -- */

export function fetchCreditSchedule(loanId: string): Promise<{ data: CreditRepayment[] }> {
  return apiFetch(`/credit/applications/${encodeURIComponent(loanId)}/schedule`);
}

export function payCreditInstallment(
  loanId: string,
  sequence: number
): Promise<{ data: CreditRepayment }> {
  return apiFetch(
    `/credit/applications/${encodeURIComponent(loanId)}/repayments/${sequence}/pay`,
    { method: 'POST' }
  );
}

/* -- collateral + guarantors -- */

export function listCreditCollateral(loanId: string): Promise<{ data: CreditCollateral[] }> {
  return apiFetch(`/credit/applications/${encodeURIComponent(loanId)}/collateral`);
}

export function listCreditGuarantors(loanId: string): Promise<{ data: CreditGuarantor[] }> {
  return apiFetch(`/credit/applications/${encodeURIComponent(loanId)}/guarantors`);
}

/* -- groups -- */

export function listCreditGroups(): Promise<{ data: CreditGroup[] }> {
  return apiFetch('/credit/groups');
}

export function listMyCreditGroups(): Promise<{ data: CreditGroupWithMembers[] }> {
  return apiFetch('/credit/groups/mine');
}

export function createCreditGroup(input: {
  name: string;
  chapterId?: string;
}): Promise<{ data: CreditGroupWithMembers }> {
  return apiFetch('/credit/groups', { method: 'POST', body: input });
}

export function joinCreditGroup(groupId: string): Promise<{ data: CreditGroupMember }> {
  return apiFetch(`/credit/groups/${encodeURIComponent(groupId)}/join`, { method: 'POST' });
}

/* -- savings -- */

export function fetchOwnSavingsAccount(): Promise<{ data: CreditSavingsAccount }> {
  return apiFetch('/credit/savings/accounts/mine');
}

export function fetchOwnSavingsTransactions(): Promise<{ data: CreditSavingsTransaction[] }> {
  return apiFetch('/credit/savings/accounts/mine/transactions');
}

export function depositOwnSavings(
  amountKobo: number,
  ref: string
): Promise<{ data: SavingsTransactionResult }> {
  return apiFetch('/credit/savings/accounts/mine/deposits', {
    method: 'POST',
    body: { amountKobo, ref }
  });
}

export function withdrawOwnSavings(
  amountKobo: number,
  ref: string
): Promise<{ data: SavingsTransactionResult }> {
  return apiFetch('/credit/savings/accounts/mine/withdrawals', {
    method: 'POST',
    body: { amountKobo, ref }
  });
}

/* -- portfolio + scoring -- */

export function fetchCreditPortfolio(): Promise<{ data: CreditPortfolioReport }> {
  return apiFetch('/credit/portfolio');
}

export function fetchCreditScoreAssessment(
  userId: string
): Promise<{ data: CreditScoreAssessment }> {
  return apiFetch(`/credit/score/${encodeURIComponent(userId)}`);
}

/* ------------------------- voice agronomist (wave-voice) ---------------- */
/* Mirrors apps/api/src/modules/voice (voice.controller). Plain `{ data: T } */
/* envelopes throughout. Agent-assist console endpoints are role-gated        */
/* (agronomist/admin) server-side.                                            */

export type VoiceChannel = 'ivr' | 'ussd' | 'assisted';
export type VoiceSessionState = 'intake' | 'triage' | 'advisory' | 'escalated' | 'resolved';
export type VoiceAgentCaseStatus = 'open' | 'assigned' | 'responded' | 'resolved';
export type VoiceAgentCaseReason = 'requested' | 'low_confidence' | 'no_grounding';

export interface VoiceAgentCase {
  id: string;
  sessionId: string;
  farmerUserId?: string;
  phone: string;
  channel: VoiceChannel;
  status: VoiceAgentCaseStatus;
  reason: VoiceAgentCaseReason;
  priority: 'normal' | 'high';
  slaDueAt: string;
  assignedAgentId?: string;
  suggestedAnswer?: string;
  citationChunkIds: string[];
  response?: string;
  respondedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceSession {
  id: string;
  channel: VoiceChannel;
  state: VoiceSessionState;
  phone: string;
  ninRef?: string;
  farmerUserId?: string;
  locale: string;
  crop?: string;
  symptomCategory?: string;
  activeCaseId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceTurn {
  id: string;
  sessionId: string;
  turnIndex: number;
  speaker: 'farmer' | 'assistant' | 'agent';
  text: string;
  citedChunkIds: string[];
  confidence?: number;
  createdAt: string;
}

export interface VoiceAgentCaseDetail {
  agentCase: VoiceAgentCase;
  session: VoiceSession;
  turns: VoiceTurn[];
}

/** Agent queue, ordered by SLA deadline (soonest first). */
export function fetchVoiceAgentCases(filter?: {
  status?: VoiceAgentCaseStatus;
  overdue?: boolean;
}): Promise<{ data: VoiceAgentCase[] }> {
  return apiFetch('/voice/agent-cases', {
    query: { status: filter?.status, overdue: filter?.overdue ? 'true' : undefined }
  });
}

/** Case detail: case + session + full transcript with RAG citations. */
export function fetchVoiceAgentCase(id: string): Promise<{ data: VoiceAgentCaseDetail }> {
  return apiFetch(`/voice/agent-cases/${encodeURIComponent(id)}`);
}

/** Agent first response; resolve=true closes the case and the session. */
export function respondVoiceAgentCase(
  id: string,
  body: { response: string; resolve?: boolean }
): Promise<{ data: { agentCase: VoiceAgentCase; session: VoiceSession } }> {
  return apiFetch(`/voice/agent-cases/${encodeURIComponent(id)}/respond`, {
    method: 'POST',
    body
  });
}

/* -- geo-verified credit (wave-geocredit, SHADOW MODE — never used in decisions) -- */

export function fetchGeoCreditShadow(id: string): Promise<{ data: GeoCreditShadowScore }> {
  return apiFetch(`/credit/applications/${encodeURIComponent(id)}/geo-shadow`);
}

export interface GeoShadowRecomputeReport {
  mode: 'off' | 'shadow';
  applications: number;
  recomputed: number;
  skipped: number;
  unavailable: number;
  failed: number;
  computedAt: string;
}

export function recomputeGeoCreditShadow(): Promise<{ data: GeoShadowRecomputeReport }> {
  return apiFetch('/credit/geo-shadow/recompute', { method: 'POST' });
}

/* =================================================================
 * Parametric insurance rail (wave-insurance).
 * Mirrors apps/api/src/modules/insurance (insurance.controller). Plain
 * `{ data: T }` envelopes throughout. Admin/cron endpoints (evaluate-
 * triggers, expire, payout confirm) are role-gated server-side and not
 * called from the farmer UI.
 * ====================================================================== */

export type { ParametricPayout, ParametricPolicy, ParametricProduct, ParametricQuote, ParametricTriggerEvent };

export interface ParametricQuoteInput {
  productCode: string;
  plotId: string;
  season: string;
  sumInsuredKobo: number;
}

export interface ParametricQuoteResponse {
  quote: ParametricQuote;
  policy: ParametricPolicy;
}

export function fetchInsuranceProducts(): Promise<{ data: ParametricProduct[] }> {
  return apiFetch('/insurance/products');
}

export function quoteParametricPolicy(
  input: ParametricQuoteInput,
  idempotencyKey?: string
): Promise<{ data: ParametricQuoteResponse }> {
  return apiFetch('/insurance/quotes', { method: 'POST', body: input, idempotencyKey });
}

export function issueInsurancePolicy(id: string): Promise<{ data: ParametricPolicy }> {
  return apiFetch(`/insurance/policies/${encodeURIComponent(id)}/issue`, { method: 'POST' });
}

export function fetchMyInsurancePolicies(): Promise<{ data: ParametricPolicy[] }> {
  return apiFetch('/insurance/policies/mine');
}

export function fetchMyInsuranceTriggerEvents(): Promise<{ data: ParametricTriggerEvent[] }> {
  return apiFetch('/insurance/trigger-events');
}

export function fetchMyInsurancePayouts(): Promise<{ data: ParametricPayout[] }> {
  return apiFetch('/insurance/payouts');
}
/* -- EUDR traceability passport (wave-eudr) -- */

export type CustodyEventType =
  | 'CREATED'
  | 'AGGREGATED'
  | 'SPLIT'
  | 'TRANSFORMED'
  | 'SHIPPED'
  | 'RECEIVED';

export interface CommodityLot {
  id: string;
  ownerUserId: string;
  crop: string;
  variety?: string;
  harvestWindowStart: string;
  harvestWindowEnd: string;
  quantity: number;
  unit: string;
  status: 'active' | 'aggregated' | 'split' | 'shipped' | 'received';
  parentLotIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CustodyEvent {
  id: string;
  lotId: string;
  seq: number;
  type: CustodyEventType;
  actorId: string;
  occurredAt: string;
  latitude: number;
  longitude: number;
  h3Cell?: string;
  quantity?: number;
  unit?: string;
  parentLotIds: string[];
  note?: string;
  prevEventHash: string;
  eventHash: string;
  createdAt: string;
}

export interface EventVerification {
  eventId: string;
  lotId: string;
  seq: number;
  type: CustodyEventType;
  hashValid: boolean;
  prevLinkValid: boolean;
  valid: boolean;
  expectedHash: string;
  storedHash: string;
}

export interface ChainVerification {
  lotId: string;
  eventCount: number;
  valid: boolean;
  events: EventVerification[];
}

export interface LotTimeline {
  lot: CommodityLot;
  events: CustodyEvent[];
  verification: ChainVerification;
}

export interface TraceabilityShipment {
  id: string;
  creatorId: string;
  creatorKind: 'user' | 'partner';
  reference?: string;
  status: 'created' | 'exported';
  createdAt: string;
  updatedAt: string;
}

export interface EudrDds {
  statementVersion: '1.0';
  generatedAt: string;
  ddsReference: string;
  operator: {
    status: 'TO_BE_COMPLETED_BY_EXPORTER';
    legalName: string | null;
    eori: string | null;
    address: string | null;
    note: string;
  };
  commodity: { description: string; crops: string[] };
  quantity: { value: number; unit: string };
  countryOfProduction: 'NG';
  productionPlots: Array<{
    plotId: string;
    lotId: string;
    latitude: number;
    longitude: number;
    h3Cell?: string;
    snapshotAt: string;
  }>;
  harvestWindow: { start: string; end: string };
  custodySummary: {
    lotCount: number;
    eventCount: number;
    firstEventAt?: string;
    lastEventAt?: string;
    eventTypes: string[];
  };
  deforestationRisk: {
    basis: 'live' | 'stub' | 'unavailable' | 'none';
    note: string;
    assessments: Array<{
      plotId: string;
      basis: string;
      floodDetected?: boolean;
      severity?: string;
      source?: string;
      detail?: string;
    }>;
  };
  chainIntegrity: {
    verified: boolean;
    eventCount: number;
    lots: Array<{ lotId: string; valid: boolean; eventCount: number; headHash?: string }>;
    verifiedAt: string;
  };
  disclaimers: string[];
}

export interface ShipmentVerification {
  shipmentId: string;
  allValid: boolean;
  eventCount: number;
  lots: ChainVerification[];
}

export interface CreateCommodityLotInput {
  crop: string;
  variety?: string;
  harvestWindowStart: string;
  harvestWindowEnd: string;
  quantity: number;
  unit: string;
}

export interface AddCustodyEventInput {
  type: CustodyEventType;
  occurredAt: string;
  latitude: number;
  longitude: number;
  h3Cell?: string;
  quantity?: number;
  unit?: string;
  note?: string;
}

export function listCommodityLots(): Promise<{ data: CommodityLot[] }> {
  return apiFetch('/traceability/lots');
}

export function createCommodityLot(
  input: CreateCommodityLotInput,
  idempotencyKey?: string
): Promise<{ data: CommodityLot }> {
  return apiFetch('/traceability/lots', { method: 'POST', body: input, idempotencyKey });
}

export function fetchLotTimeline(lotId: string): Promise<{ data: LotTimeline }> {
  return apiFetch(`/traceability/lots/${encodeURIComponent(lotId)}/timeline`);
}

export function addCustodyEvent(
  lotId: string,
  input: AddCustodyEventInput,
  idempotencyKey?: string
): Promise<{ data: CustodyEvent }> {
  return apiFetch(`/traceability/lots/${encodeURIComponent(lotId)}/events`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

export function createTraceabilityShipment(
  input: { lotIds: string[]; reference?: string },
  idempotencyKey?: string
): Promise<{ data: { shipment: TraceabilityShipment; lots: CommodityLot[] } }> {
  return apiFetch('/traceability/shipments', { method: 'POST', body: input, idempotencyKey });
}

export function fetchShipmentDds(shipmentId: string): Promise<{ data: EudrDds }> {
  return apiFetch(`/traceability/shipments/${encodeURIComponent(shipmentId)}/dds`);
}

export function verifyShipmentDds(shipmentId: string): Promise<{ data: ShipmentVerification }> {
  return apiFetch(`/traceability/shipments/${encodeURIComponent(shipmentId)}/dds/verify`);
}

/* -------- mechanization marketplace (wave-mechanization) -------- */

import type {
  EquipmentBooking,
  EquipmentListing,
  EquipmentType,
  MechBookingStatus,
  OperatorVerificationStatus,
  OwnerUtilizationStats
} from '@agric-platform/shared';

export function listEquipmentListings(params: {
  type?: EquipmentType;
  h3Cell?: string;
  lat?: number;
  long?: number;
  availableFrom?: string;
  availableTo?: string;
} = {}): Promise<{ data: EquipmentListing[] }> {
  return apiFetch('/mechanization/listings', { query: { ...params } });
}

export function fetchEquipmentListing(id: string): Promise<{ data: EquipmentListing }> {
  return apiFetch(`/mechanization/listings/${encodeURIComponent(id)}`);
}

export function createEquipmentListing(input: {
  ownerType: EquipmentListing['ownerType'];
  type: EquipmentType;
  title: string;
  description?: string;
  specs?: Record<string, unknown>;
  baseLat: number;
  baseLong: number;
  serviceAreaResolution: number;
  serviceAreaRing: number;
  rates: EquipmentListing['rates'];
  availability: { start: string; end: string }[];
  operatorLicenseRef?: string;
}): Promise<{ data: EquipmentListing }> {
  return apiFetch('/mechanization/listings', { method: 'POST', body: input });
}

export function listMyEquipmentListings(): Promise<{ data: EquipmentListing[] }> {
  return apiFetch('/mechanization/listings/mine');
}

export function setEquipmentListingStatus(
  id: string,
  status: EquipmentListing['status']
): Promise<{ data: EquipmentListing }> {
  return apiFetch(`/mechanization/listings/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    body: { status }
  });
}

export function requestEquipmentBooking(
  listingId: string,
  input: {
    plotId?: string;
    plotLat: number;
    plotLong: number;
    areaHa: number;
    estimatedHours?: number;
    windowStart: string;
    windowEnd: string;
  },
  idempotencyKey?: string
): Promise<{ data: EquipmentBooking }> {
  return apiFetch(`/mechanization/listings/${encodeURIComponent(listingId)}/bookings`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

/** Own bookings (farmer), newest first. Plain `{ data: T[] }` envelope. */
export function listMyEquipmentBookings(): Promise<{ data: EquipmentBooking[] }> {
  return apiFetch('/mechanization/bookings/mine');
}

/** Owner booking queue. Plain `{ data: T[] }` envelope. */
export function listOwnerEquipmentBookings(params: {
  status?: MechBookingStatus;
} = {}): Promise<{ data: EquipmentBooking[] }> {
  return apiFetch('/mechanization/bookings/queue', { query: { ...params } });
}

export function fetchEquipmentBooking(id: string): Promise<{ data: EquipmentBooking }> {
  return apiFetch(`/mechanization/bookings/${encodeURIComponent(id)}`);
}

export function quoteEquipmentBooking(id: string): Promise<{ data: EquipmentBooking }> {
  return apiFetch(`/mechanization/bookings/${encodeURIComponent(id)}/quote`, { method: 'POST' });
}

export function confirmEquipmentBooking(id: string): Promise<{ data: EquipmentBooking }> {
  return apiFetch(`/mechanization/bookings/${encodeURIComponent(id)}/confirm`, { method: 'POST' });
}

export function startEquipmentService(id: string): Promise<{ data: EquipmentBooking }> {
  return apiFetch(`/mechanization/bookings/${encodeURIComponent(id)}/start`, { method: 'POST' });
}

export function completeEquipmentBooking(id: string): Promise<{ data: EquipmentBooking }> {
  return apiFetch(`/mechanization/bookings/${encodeURIComponent(id)}/complete`, { method: 'POST' });
}

export function cancelEquipmentBooking(
  id: string,
  reason?: string
): Promise<{ data: EquipmentBooking }> {
  return apiFetch(`/mechanization/bookings/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: { reason }
  });
}

export function rateEquipmentBooking(
  id: string,
  rating: number,
  comment?: string
): Promise<{ data: EquipmentBooking }> {
  return apiFetch(`/mechanization/bookings/${encodeURIComponent(id)}/rate`, {
    method: 'POST',
    body: { rating, comment }
  });
}

export function fetchOwnerUtilization(): Promise<{ data: OwnerUtilizationStats }> {
  return apiFetch('/mechanization/owner/stats');
}

export type { EquipmentBooking, EquipmentListing, MechBookingStatus, OperatorVerificationStatus };

/* --- agent banking (wave-agentbank) --- */

export type AgentBankingStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED';
export type AgentTopUpStatus = 'REQUESTED' | 'APPROVED' | 'SETTLED' | 'REJECTED';
export type AgentVoucherStatus = 'ISSUED' | 'REDEEMED' | 'EXPIRED' | 'VOIDED';
export type AgentTransactionType = 'cash_in' | 'cash_out' | 'voucher_redemption';

export interface AgentBankingAgent {
  id: string;
  userId: string;
  organisation: string;
  status: AgentBankingStatus;
  floatAccountCode: string;
  commissionAccountCode: string;
  dailyLimitKobo: number;
  lowFloatThresholdKobo: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentFloatBalance {
  agentId: string;
  floatAccountCode: string;
  balanceKobo: number;
  lowFloatThresholdKobo: number;
  lowFloat: boolean;
}

export interface AgentFloatTopUp {
  id: string;
  agentId: string;
  amountKobo: number;
  status: AgentTopUpStatus;
  requestedBy: string;
  decidedBy?: string;
  decidedAt?: string;
  settledAt?: string;
  ledgerEntryId?: string;
  rejectionReason?: string;
  createdAt: string;
}

export interface AgentTransaction {
  id: string;
  agentId: string;
  farmerId: string;
  type: AgentTransactionType;
  amountKobo: number;
  commissionKobo: number;
  idempotencyKey: string;
  ledgerEntryId: string;
  voucherId?: string;
  createdAt: string;
}

export interface AgentVoucher {
  id: string;
  agentId: string;
  farmerId: string;
  amountKobo: number;
  expiresAt: string;
  nonce: string;
  signature: string;
  status: AgentVoucherStatus;
  redeemedAt?: string;
  ledgerEntryId?: string;
  createdAt: string;
}

export interface AgentCommissionStatement {
  agentId: string;
  month: string;
  rows: Array<{
    type: AgentTransactionType;
    count: number;
    volumeKobo: number;
    commissionKobo: number;
  }>;
  totalCommissionKobo: number;
  commissionPayableKobo: number;
}

export interface AgentReconciliation {
  agentId: string;
  date: string;
  openingFloatKobo: number;
  closingFloatKobo: number;
  volumeByType: Record<'cash_in' | 'cash_out' | 'voucher_redemption' | 'float_topup', number>;
  commissionAccruedKobo: number;
  transactionCount: number;
}

/** Own agent profile (agent self-service). */
export function fetchMyAgentProfile(): Promise<{ data: AgentBankingAgent }> {
  return apiFetch('/agent-banking/agents/me');
}

export function fetchAgentFloat(agentId: string): Promise<{ data: AgentFloatBalance }> {
  return apiFetch(`/agent-banking/agents/${encodeURIComponent(agentId)}/float`);
}

export function requestAgentTopUp(
  agentId: string,
  amountKobo: number
): Promise<{ data: AgentFloatTopUp }> {
  return apiFetch(`/agent-banking/agents/${encodeURIComponent(agentId)}/top-ups`, {
    method: 'POST',
    body: { amountKobo }
  });
}

export function fetchAgentTopUps(agentId: string): Promise<{ data: AgentFloatTopUp[] }> {
  return apiFetch(`/agent-banking/agents/${encodeURIComponent(agentId)}/top-ups`);
}

/** Supervisor/admin approval queue. */
export function fetchTopUpQueue(status?: AgentTopUpStatus): Promise<{ data: AgentFloatTopUp[] }> {
  return apiFetch('/agent-banking/top-ups', { query: { status } });
}

export function approveTopUp(id: string): Promise<{ data: AgentFloatTopUp }> {
  return apiFetch(`/agent-banking/top-ups/${encodeURIComponent(id)}/approve`, { method: 'POST' });
}

export function rejectTopUp(id: string, reason: string): Promise<{ data: AgentFloatTopUp }> {
  return apiFetch(`/agent-banking/top-ups/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: { reason }
  });
}

export function settleTopUp(id: string): Promise<{ data: AgentFloatTopUp }> {
  return apiFetch(`/agent-banking/top-ups/${encodeURIComponent(id)}/settle`, { method: 'POST' });
}

export function fetchAgentTransactions(
  agentId: string,
  filter?: { type?: AgentTransactionType; from?: string; to?: string }
): Promise<{ data: AgentTransaction[] }> {
  return apiFetch(`/agent-banking/agents/${encodeURIComponent(agentId)}/transactions`, {
    query: { type: filter?.type, from: filter?.from, to: filter?.to }
  });
}

export function issueAgentVoucher(
  agentId: string,
  input: { farmerId: string; amountKobo: number }
): Promise<{ data: AgentVoucher }> {
  return apiFetch(`/agent-banking/agents/${encodeURIComponent(agentId)}/vouchers`, {
    method: 'POST',
    body: input
  });
}

export function fetchAgentVouchers(
  agentId: string,
  status?: AgentVoucherStatus
): Promise<{ data: AgentVoucher[] }> {
  return apiFetch(`/agent-banking/agents/${encodeURIComponent(agentId)}/vouchers`, {
    query: { status }
  });
}

export function redeemAgentVoucher(
  id: string,
  signature?: string
): Promise<{ data: { voucher: AgentVoucher; transaction: AgentTransaction } }> {
  return apiFetch(`/agent-banking/vouchers/${encodeURIComponent(id)}/redeem`, {
    method: 'POST',
    body: { signature }
  });
}

export function fetchAgentCommissionStatement(
  agentId: string,
  month: string
): Promise<{ data: AgentCommissionStatement }> {
  return apiFetch(`/agent-banking/agents/${encodeURIComponent(agentId)}/commissions`, {
    query: { month }
  });
}

export function fetchAgentReconciliation(
  agentId: string,
  date: string
): Promise<{ data: AgentReconciliation }> {
  return apiFetch(`/agent-banking/agents/${encodeURIComponent(agentId)}/reconciliation`, {
    query: { date }
  });
}

/* --- end agent banking (wave-agentbank) --- */

/* --- input vouchers (wave-nin-vouchers) --- */

export type SubsidyProgrammeStatus = 'DRAFT' | 'ACTIVE' | 'CLOSED';
export type SubsidyVoucherStatus = 'ISSUED' | 'REDEEMED' | 'EXPIRED' | 'VOIDED';
export type IdentityBasis = 'stub' | 'live';

export interface SubsidyProgramme {
  id: string;
  name: string;
  sponsor: string;
  description?: string;
  status: SubsidyProgrammeStatus;
  perFarmerCapKobo: number;
  budgetKobo: number;
  eligibleStates: string[];
  eligibleCrops: string[];
  liabilityAccountCode: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubsidyBeneficiary {
  id: string;
  programmeId: string;
  farmerId: string;
  /** Salted HMAC hash — the plaintext NIN is never stored or returned. */
  ninHash: string;
  ninMask: string;
  verificationBasis: IdentityBasis;
  nameMatchScore?: number;
  state?: string;
  primaryCrop?: string;
  verifiedAt: string;
  createdAt: string;
}

export interface SubsidyVoucher {
  id: string;
  programmeId: string;
  beneficiaryId: string;
  farmerId: string;
  amountKobo: number;
  status: SubsidyVoucherStatus;
  idempotencyKey: string;
  expiresAt: string;
  distributedAt?: string;
  redeemedAt?: string;
  voidedAt?: string;
  ledgerEntryId?: string;
  createdAt: string;
}

export interface SubsidyRedemption {
  id: string;
  voucherId: string;
  programmeId: string;
  supplierId: string;
  invoiceRef: string;
  amountKobo: number;
  idempotencyKey: string;
  ledgerEntryId: string;
  createdAt: string;
}

export interface SubsidyReconciliation {
  programmeId: string;
  budgetKobo: number;
  totals: {
    vouchersIssued: number;
    allocatedKobo: number;
    outstandingCount: number;
    outstandingKobo: number;
    redeemedCount: number;
    redeemedKobo: number;
    expiredCount: number;
    expiredKobo: number;
    voidedCount: number;
    voidedKobo: number;
    beneficiariesVerified: number;
  };
  byState: Array<{
    state: string;
    vouchersIssued: number;
    outstandingKobo: number;
    redeemedKobo: number;
  }>;
  ledger: {
    liabilityAccountCode: string;
    liabilityKobo: number;
    expectedLiabilityKobo: number;
    discrepancyKobo: number;
  };
  generatedAt: string;
}

export interface SubsidyIdentityStatus {
  driver: IdentityBasis;
  configured: boolean;
  detail: string;
}

/** Programmes (admin create; admin/regulator/donor read). */
export function fetchSubsidyProgrammes(status?: SubsidyProgrammeStatus): Promise<{ data: SubsidyProgramme[] }> {
  return apiFetch('/input-vouchers/programmes', { query: { status } });
}

export function createSubsidyProgramme(input: {
  name: string;
  sponsor: string;
  description?: string;
  perFarmerCapKobo: number;
  budgetKobo: number;
  eligibleStates?: string[];
  eligibleCrops?: string[];
}): Promise<{ data: SubsidyProgramme }> {
  return apiFetch('/input-vouchers/programmes', { method: 'POST', body: input });
}

export function activateSubsidyProgramme(id: string): Promise<{ data: SubsidyProgramme }> {
  return apiFetch(`/input-vouchers/programmes/${encodeURIComponent(id)}/activate`, { method: 'POST' });
}

export function closeSubsidyProgramme(id: string): Promise<{ data: SubsidyProgramme }> {
  return apiFetch(`/input-vouchers/programmes/${encodeURIComponent(id)}/close`, { method: 'POST' });
}

/** Beneficiary enrolment (admin; NIN verified then discarded — hash + mask only). */
export function verifySubsidyBeneficiary(
  programmeId: string,
  input: { farmerId: string; nin: string; fullName: string; state?: string; primaryCrop?: string }
): Promise<{ data: SubsidyBeneficiary }> {
  return apiFetch(`/input-vouchers/programmes/${encodeURIComponent(programmeId)}/beneficiaries`, {
    method: 'POST',
    body: input
  });
}

export function fetchSubsidyBeneficiaries(programmeId: string): Promise<{ data: SubsidyBeneficiary[] }> {
  return apiFetch(`/input-vouchers/programmes/${encodeURIComponent(programmeId)}/beneficiaries`);
}

/** Voucher lifecycle. */
export function allocateSubsidyVoucher(
  programmeId: string,
  input: { farmerId: string; amountKobo: number; idempotencyKey: string; expiresAt?: string }
): Promise<{ data: SubsidyVoucher }> {
  return apiFetch(`/input-vouchers/programmes/${encodeURIComponent(programmeId)}/vouchers`, {
    method: 'POST',
    body: input
  });
}

export function fetchProgrammeVouchers(
  programmeId: string,
  status?: SubsidyVoucherStatus
): Promise<{ data: SubsidyVoucher[] }> {
  return apiFetch(`/input-vouchers/programmes/${encodeURIComponent(programmeId)}/vouchers`, {
    query: { status }
  });
}

export function fetchMySubsidyVouchers(status?: SubsidyVoucherStatus): Promise<{ data: SubsidyVoucher[] }> {
  return apiFetch('/input-vouchers/farmers/me/vouchers', { query: { status } });
}

export function distributeSubsidyVoucher(id: string): Promise<{ data: SubsidyVoucher }> {
  return apiFetch(`/input-vouchers/vouchers/${encodeURIComponent(id)}/distribute`, { method: 'POST' });
}

export function redeemSubsidyVoucher(
  id: string,
  invoiceRef: string
): Promise<{ data: { voucher: SubsidyVoucher; redemption: SubsidyRedemption } }> {
  return apiFetch(`/input-vouchers/vouchers/${encodeURIComponent(id)}/redeem`, {
    method: 'POST',
    body: { invoiceRef }
  });
}

export function voidSubsidyVoucher(id: string): Promise<{ data: SubsidyVoucher }> {
  return apiFetch(`/input-vouchers/vouchers/${encodeURIComponent(id)}/void`, { method: 'POST' });
}

/** Reconciliation export (admin/regulator/donor) + identity adapter diagnostics (admin). */
export function fetchSubsidyReconciliation(programmeId: string): Promise<{ data: SubsidyReconciliation }> {
  return apiFetch(`/input-vouchers/programmes/${encodeURIComponent(programmeId)}/reconciliation`);
}

export function fetchSubsidyIdentityStatus(): Promise<{ data: SubsidyIdentityStatus }> {
  return apiFetch('/input-vouchers/identity/status');
}

/* --- end input vouchers (wave-nin-vouchers) --- */
/* --- warehouse receipts (wave-warehouse) --- */

import type {
  CertifiedWarehouse,
  WarehouseCertificationStatus,
  WarehouseDeposit,
  WarehouseGrade,
  WarehousePledge,
  WarehouseReceipt,
  WarehouseReceiptTransfer,
  WarehouseRegistryExport
} from '@agric-platform/shared';

export interface WarehouseIntegrationStatus {
  certificationDriver: 'stub' | 'live';
  collateralRegistryDriver: 'stub' | 'live';
}

export function listWarehouses(params: {
  state?: string;
  lga?: string;
  certificationStatus?: WarehouseCertificationStatus;
} = {}): Promise<{ data: CertifiedWarehouse[] }> {
  return apiFetch('/warehouse/warehouses', { query: { ...params } });
}

export function fetchWarehouse(id: string): Promise<{ data: CertifiedWarehouse }> {
  return apiFetch(`/warehouse/warehouses/${encodeURIComponent(id)}`);
}

export function registerWarehouse(input: {
  name: string;
  state: string;
  lga: string;
  latitude: number;
  longitude: number;
  capacityTonnes: number;
  operatorLicenseRef?: string;
}): Promise<{ data: CertifiedWarehouse }> {
  return apiFetch('/warehouse/warehouses', { method: 'POST', body: input });
}

export function refreshWarehouseCertification(id: string): Promise<{ data: CertifiedWarehouse }> {
  return apiFetch(`/warehouse/warehouses/${encodeURIComponent(id)}/certification`, {
    method: 'POST'
  });
}

export function createWarehouseDeposit(input: {
  warehouseId: string;
  lotId?: string;
  crop: string;
}): Promise<{ data: WarehouseDeposit }> {
  return apiFetch('/warehouse/deposits', { method: 'POST', body: input });
}

export function listMyWarehouseDeposits(): Promise<{ data: WarehouseDeposit[] }> {
  return apiFetch('/warehouse/deposits/mine');
}

export function fetchWarehouseDeposit(id: string): Promise<{ data: WarehouseDeposit }> {
  return apiFetch(`/warehouse/deposits/${encodeURIComponent(id)}`);
}

export function gradeWarehouseDeposit(
  id: string,
  input: { grade: WarehouseGrade; moisturePercent: number; bagCount: number; weightKg: number }
): Promise<{ data: WarehouseDeposit }> {
  return apiFetch(`/warehouse/deposits/${encodeURIComponent(id)}/grading`, {
    method: 'POST',
    body: input
  });
}

export function issueWarehouseReceipt(id: string): Promise<{ data: WarehouseReceipt }> {
  return apiFetch(`/warehouse/deposits/${encodeURIComponent(id)}/receipt`, { method: 'POST' });
}

export function listMyWarehouseReceipts(): Promise<{ data: WarehouseReceipt[] }> {
  return apiFetch('/warehouse/receipts/mine');
}

export function fetchWarehouseReceipt(id: string): Promise<{ data: WarehouseReceipt }> {
  return apiFetch(`/warehouse/receipts/${encodeURIComponent(id)}`);
}

export function verifyWarehouseReceipt(
  id: string
): Promise<{ data: { receiptNumber: string; valid: boolean } }> {
  return apiFetch(`/warehouse/receipts/${encodeURIComponent(id)}/verify`);
}

export function listReceiptPledges(id: string): Promise<{ data: WarehousePledge[] }> {
  return apiFetch(`/warehouse/receipts/${encodeURIComponent(id)}/pledges`);
}

export function listReceiptTransfers(id: string): Promise<{ data: WarehouseReceiptTransfer[] }> {
  return apiFetch(`/warehouse/receipts/${encodeURIComponent(id)}/transfers`);
}

export function pledgeWarehouseReceipt(
  id: string,
  input: { principalKobo: number; terms?: string },
  idempotencyKey?: string
): Promise<{ data: { receipt: WarehouseReceipt; pledge: WarehousePledge } }> {
  return apiFetch(`/warehouse/receipts/${encodeURIComponent(id)}/pledge`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

export function releaseWarehousePledge(
  id: string
): Promise<{ data: { receipt: WarehouseReceipt; pledge: WarehousePledge } }> {
  return apiFetch(`/warehouse/receipts/${encodeURIComponent(id)}/release`, { method: 'POST' });
}

export function transferWarehouseReceipt(
  id: string,
  input: { toOwnerId: string; note?: string },
  idempotencyKey?: string
): Promise<{ data: WarehouseReceipt }> {
  return apiFetch(`/warehouse/receipts/${encodeURIComponent(id)}/transfer`, {
    method: 'POST',
    body: input,
    idempotencyKey
  });
}

export function redeemWarehouseReceipt(id: string): Promise<{ data: WarehouseReceipt }> {
  return apiFetch(`/warehouse/receipts/${encodeURIComponent(id)}/redeem`, { method: 'POST' });
}

export function listMyWarehousePledges(): Promise<{ data: WarehousePledge[] }> {
  return apiFetch('/warehouse/pledges/mine');
}

export function fetchWarehouseRegistryExport(): Promise<{ data: WarehouseRegistryExport }> {
  return apiFetch('/warehouse/registry/export');
}

export function fetchWarehouseIntegrationStatus(): Promise<{ data: WarehouseIntegrationStatus }> {
  return apiFetch('/warehouse/integrations/status');
}

/* --- end warehouse receipts (wave-warehouse) --- */

/* --- livestock passport (wave-livestock-passport) --- */

export type LivestockPassportStatus = 'active' | 'suspended' | 'revoked';
export type LivestockPassportEventType =
  | 'ISSUED'
  | 'TRANSFER_INITIATED'
  | 'TRANSFER_CONFIRMED'
  | 'TRANSFER_CANCELLED'
  | 'SUSPENDED'
  | 'REINSTATED'
  | 'REVOKED';
export type LivestockPassportTransferStatus = 'pending' | 'confirmed' | 'cancelled';
export type TagCheckBasis = 'stub' | 'live' | 'unavailable' | 'none';

export interface LivestockPassport {
  id: string;
  animalId: string;
  passportCode: string;
  codeNonce: string;
  codeSignature: string;
  ownerUserId: string;
  status: LivestockPassportStatus;
  tagCheckBasis: TagCheckBasis;
  tagCheckDetail?: string;
  issuedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PassportEvent {
  id: string;
  passportId: string;
  seq: number;
  type: LivestockPassportEventType;
  actorId: string;
  payload: Record<string, unknown>;
  prevEventHash: string;
  eventHash: string;
  createdAt: string;
}

export interface PassportEventVerification {
  eventId: string;
  passportId: string;
  seq: number;
  type: LivestockPassportEventType;
  hashValid: boolean;
  prevLinkValid: boolean;
  valid: boolean;
  expectedHash: string;
  storedHash: string;
}

export interface PassportChainVerification {
  passportId: string;
  eventCount: number;
  valid: boolean;
  headHash?: string;
  events: PassportEventVerification[];
}

export interface PassportTransfer {
  id: string;
  passportId: string;
  animalId: string;
  fromUserId: string;
  toUserId: string;
  status: LivestockPassportTransferStatus;
  note?: string;
  executedTransferId?: string;
  initiatedAt: string;
  confirmedAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PassportVaccinationSummary {
  requiredVaccinations: readonly string[];
  completedVaccinations: string[];
  coverage: number;
  vaccinationCount: number;
  treatmentCount: number;
  activeWithdrawal: boolean;
  lastVaccinationAt?: string;
}

export interface PassportMovementSummary {
  totalMovements: number;
  movementsWithPermit: number;
  openMovements: number;
  revokedPermits: number;
  legal: boolean;
}

export interface PassportDocument {
  passport: LivestockPassport;
  animal: {
    id: string;
    species: string;
    breed: string;
    sex: string;
    birthDate?: string;
    state: string;
    status: string;
    ownerUserId: string;
  };
  owner: { userId: string; fullName: string };
  vaccinationSummary: PassportVaccinationSummary;
  movementSummary: PassportMovementSummary;
  activeLien?: { id: string; status: string };
  insurancePolicies: Array<{ id: string; status: string }>;
  passportTransfers: PassportTransfer[];
  chain: PassportChainVerification;
}

export interface PublicPassportVerification {
  verified: true;
  passportCode: string;
  passportStatus: LivestockPassportStatus;
  animal: {
    id: string;
    species: string;
    breed: string;
    sex: string;
    birthDate?: string;
    state: string;
    status: string;
  };
  /** Owner identity redacted to initials only (e.g. "A.B."). */
  ownerInitials: string;
  vaccinationSummary: {
    requiredVaccinations: readonly string[];
    completedVaccinations: string[];
    coverage: number;
    activeWithdrawal: boolean;
  };
  movementLegality: {
    totalMovements: number;
    movementsWithPermit: number;
    legal: boolean;
  };
  encumbrance: { activeLien: boolean; insured: boolean };
  tagCheck: { basis: TagCheckBasis; stub: boolean };
  chain: { eventCount: number; valid: boolean; headHash?: string };
  qr: { code: string; verifyPath: string };
  disclaimers: string[];
}

export function issueLivestockPassport(
  animalId: string
): Promise<{ data: PassportDocument }> {
  return apiFetch(`/livestock-passport/animals/${encodeURIComponent(animalId)}`, {
    method: 'POST'
  });
}

export function fetchMyLivestockPassports(): Promise<{ data: PassportDocument[] }> {
  return apiFetch('/livestock-passport/mine');
}

export function fetchLivestockPassport(id: string): Promise<{ data: PassportDocument }> {
  return apiFetch(`/livestock-passport/${encodeURIComponent(id)}`);
}

export function fetchLivestockPassportEvents(
  id: string
): Promise<{
  data: { passport: LivestockPassport; events: PassportEvent[]; verification: PassportChainVerification };
}> {
  return apiFetch(`/livestock-passport/${encodeURIComponent(id)}/events`);
}

/** PUBLIC QR verification — no session required (HMAC-signed code). */
export function verifyLivestockPassport(
  code: string
): Promise<{ data: PublicPassportVerification }> {
  return apiFetch(`/livestock-passport/verify/${encodeURIComponent(code)}`);
}

export function fetchPassportTransfers(
  direction: 'incoming' | 'outgoing'
): Promise<{ data: PassportTransfer[] }> {
  return apiFetch('/livestock-passport/transfers', { query: { direction } });
}

export function initiatePassportTransfer(
  passportId: string,
  input: { toUserId: string; note?: string }
): Promise<{ data: PassportTransfer }> {
  return apiFetch(`/livestock-passport/${encodeURIComponent(passportId)}/transfers`, {
    method: 'POST',
    body: input
  });
}

export function confirmPassportTransfer(
  transferId: string
): Promise<{ data: PassportTransfer }> {
  return apiFetch(`/livestock-passport/transfers/${encodeURIComponent(transferId)}/confirm`, {
    method: 'POST'
  });
}

export function cancelPassportTransfer(
  transferId: string
): Promise<{ data: PassportTransfer }> {
  return apiFetch(`/livestock-passport/transfers/${encodeURIComponent(transferId)}/cancel`, {
    method: 'POST'
  });
}

/* --- end livestock passport (wave-livestock-passport) --- */

/* --- vsla carbon mrv (wave-vsla-carbon) --- */

export type VslaGroupStatus = 'ACTIVE' | 'DISSOLVED';
export type VslaCycleStatus = 'OPEN' | 'CLOSED';
export type VslaLoanStatus = 'ACTIVE' | 'REPAID';
export type CarbonPracticeType = 'agroforestry' | 'fmnr' | 'woodlot' | 'conservation_agriculture';
export type CarbonBasisFlag = 'stub' | 'estimate' | 'live';

export interface VslaGroup {
  id: string;
  name: string;
  chapterId?: string;
  leadUserId: string;
  status: VslaGroupStatus;
  savingsAccountCode: string;
  loansReceivableAccountCode: string;
  interestIncomeAccountCode: string;
  createdAt: string;
  updatedAt: string;
}

export interface VslaMember {
  id: string;
  groupId: string;
  userId: string;
  role: 'member' | 'lead';
  status: 'ACTIVE' | 'EXITED';
  joinedAt: string;
  exitedAt?: string;
}

export interface VslaCycle {
  id: string;
  groupId: string;
  label: string;
  status: VslaCycleStatus;
  openedAt: string;
  closedAt?: string;
  createdAt: string;
}

export interface VslaContribution {
  id: string;
  cycleId: string;
  groupId: string;
  memberId: string;
  amountKobo: number;
  idempotencyKey: string;
  ledgerEntryId: string;
  createdAt: string;
}

export interface VslaShareOut {
  id: string;
  cycleId: string;
  memberId: string;
  shareKobo: number;
  contributedKobo: number;
  residualKobo: number;
  ledgerEntryId: string;
  createdAt: string;
}

export interface VslaShareOutReport {
  cycleId: string;
  groupId: string;
  distributableKobo: number;
  payouts: VslaShareOut[];
  closedAt: string;
  replayed: boolean;
}

export interface VslaLoan {
  id: string;
  groupId: string;
  cycleId: string;
  memberId: string;
  principalKobo: number;
  interestRateBps: number;
  totalDueKobo: number;
  repaidKobo: number;
  status: VslaLoanStatus;
  issuedAt: string;
  repaidAt?: string;
  ledgerEntryId: string;
  createdAt: string;
}

export interface CarbonPlot {
  id: string;
  groupId: string;
  ownerUserId: string;
  name: string;
  practiceType: CarbonPracticeType;
  hectaresCenti: number;
  centroidLat: number;
  centroidLong: number;
  h3Res9: string;
  status: 'ACTIVE' | 'RETIRED';
  createdAt: string;
}

export interface CarbonEvidence {
  id: string;
  plotId: string;
  groupId: string;
  season: string;
  submittedBy: string;
  submitterRole: 'farmer' | 'enumerator';
  survivalRatePct?: number;
  notes?: string;
  ndviHealthScore?: number;
  ndviClassification?: string;
  ndviBasis?: 'stub' | 'live';
  idempotencyKey: string;
  createdAt: string;
}

export interface CarbonEstimate {
  id: string;
  plotId: string;
  groupId: string;
  season: string;
  coefficientVersion: string;
  hectaresCenti: number;
  practiceType: CarbonPracticeType;
  survivalRatePct: number;
  seasonCount: number;
  co2eMilliTonnes: number;
  basis: 'estimate';
  createdAt: string;
}

export interface GroupMrvReport {
  groupId: string;
  groupName: string;
  plotCount: number;
  hectaresUnderPractice: number;
  meanSurvivalRatePct: number | null;
  estimatedCo2eTonnes: number;
  estimateCount: number;
  evidenceCount: number;
  ndviLinkedEvidenceCount: number;
  basisFlags: CarbonBasisFlag[];
  disclaimer: string;
}

export interface ProgrammeMrvReport {
  groupCount: number;
  plotCount: number;
  hectaresUnderPractice: number;
  meanSurvivalRatePct: number | null;
  estimatedCo2eTonnes: number;
  estimateCount: number;
  evidenceCount: number;
  ndviLinkedEvidenceCount: number;
  basisFlags: CarbonBasisFlag[];
  disclaimer: string;
  groups: GroupMrvReport[];
  generatedAt: string;
}

export function fetchVslaGroups(): Promise<{ data: VslaGroup[] }> {
  return apiFetch('/vsla-carbon/groups');
}

export function createVslaGroup(input: {
  name: string;
  chapterId?: string;
}): Promise<{ data: VslaGroup }> {
  return apiFetch('/vsla-carbon/groups', { method: 'POST', body: input });
}

export function fetchVslaMembers(groupId: string): Promise<{ data: VslaMember[] }> {
  return apiFetch(`/vsla-carbon/groups/${encodeURIComponent(groupId)}/members`);
}

export function addVslaMember(
  groupId: string,
  input: { userId: string; role?: 'member' | 'lead' }
): Promise<{ data: VslaMember }> {
  return apiFetch(`/vsla-carbon/groups/${encodeURIComponent(groupId)}/members`, {
    method: 'POST',
    body: input
  });
}

export function fetchVslaCycles(groupId: string): Promise<{ data: VslaCycle[] }> {
  return apiFetch(`/vsla-carbon/groups/${encodeURIComponent(groupId)}/cycles`);
}

export function openVslaCycle(groupId: string, label: string): Promise<{ data: VslaCycle }> {
  return apiFetch(`/vsla-carbon/groups/${encodeURIComponent(groupId)}/cycles`, {
    method: 'POST',
    body: { label }
  });
}

export function fetchVslaContributions(cycleId: string): Promise<{ data: VslaContribution[] }> {
  return apiFetch(`/vsla-carbon/cycles/${encodeURIComponent(cycleId)}/contributions`);
}

export function recordVslaContribution(
  cycleId: string,
  input: { memberId: string; amountKobo: number; idempotencyKey: string }
): Promise<{ data: VslaContribution }> {
  return apiFetch(`/vsla-carbon/cycles/${encodeURIComponent(cycleId)}/contributions`, {
    method: 'POST',
    body: input
  });
}

export function closeVslaCycle(cycleId: string): Promise<{ data: VslaShareOutReport }> {
  return apiFetch(`/vsla-carbon/cycles/${encodeURIComponent(cycleId)}/close`, { method: 'POST' });
}

export function fetchVslaLoans(groupId: string): Promise<{ data: VslaLoan[] }> {
  return apiFetch(`/vsla-carbon/groups/${encodeURIComponent(groupId)}/loans`);
}

export function issueVslaLoan(
  groupId: string,
  input: { memberId: string; principalKobo: number; interestRateBps: number }
): Promise<{ data: VslaLoan }> {
  return apiFetch(`/vsla-carbon/groups/${encodeURIComponent(groupId)}/loans`, {
    method: 'POST',
    body: input
  });
}

export function repayVslaLoan(
  loanId: string,
  input: { amountKobo: number; idempotencyKey: string }
): Promise<{ data: { loan: VslaLoan; repayment: { id: string; amountKobo: number } } }> {
  return apiFetch(`/vsla-carbon/loans/${encodeURIComponent(loanId)}/repayments`, {
    method: 'POST',
    body: input
  });
}

export function fetchCarbonPlots(groupId?: string): Promise<{ data: CarbonPlot[] }> {
  return apiFetch('/vsla-carbon/plots', { query: { groupId } });
}

export function registerCarbonPlot(input: {
  groupId: string;
  ownerUserId?: string;
  name: string;
  practiceType: CarbonPracticeType;
  hectares: number;
  centroidLat: number;
  centroidLong: number;
}): Promise<{ data: CarbonPlot }> {
  return apiFetch('/vsla-carbon/plots', { method: 'POST', body: input });
}

export function fetchCarbonEvidence(plotId: string): Promise<{ data: CarbonEvidence[] }> {
  return apiFetch(`/vsla-carbon/plots/${encodeURIComponent(plotId)}/evidence`);
}

export function submitCarbonEvidence(
  plotId: string,
  input: {
    season: string;
    survivalRatePct?: number;
    notes?: string;
    idempotencyKey: string;
    linkNdvi?: boolean;
  }
): Promise<{ data: CarbonEvidence }> {
  return apiFetch(`/vsla-carbon/plots/${encodeURIComponent(plotId)}/evidence`, {
    method: 'POST',
    body: input
  });
}

export function estimateCarbonPlot(
  plotId: string,
  season: string
): Promise<{ data: CarbonEstimate }> {
  return apiFetch(`/vsla-carbon/plots/${encodeURIComponent(plotId)}/estimate`, {
    method: 'POST',
    body: { season }
  });
}

export function fetchCarbonEstimates(plotId: string): Promise<{ data: CarbonEstimate[] }> {
  return apiFetch(`/vsla-carbon/plots/${encodeURIComponent(plotId)}/estimates`);
}

/** NDVI provider status — mirrors apps/api vsla-carbon.controller GET ndvi/status. */
export interface NdviProviderStatus {
  configured: boolean;
  healthy: boolean;
  detail: string;
}

export function fetchCarbonNdviStatus(): Promise<{ data: NdviProviderStatus }> {
  return apiFetch('/vsla-carbon/ndvi/status');
}

export function fetchGroupMrvReport(groupId: string): Promise<{ data: GroupMrvReport }> {
  return apiFetch(`/vsla-carbon/reports/group/${encodeURIComponent(groupId)}`);
}

export function fetchProgrammeMrvReport(): Promise<{ data: ProgrammeMrvReport }> {
  return apiFetch('/vsla-carbon/reports/programme');
}

/* --- end vsla carbon mrv (wave-vsla-carbon) --- */
