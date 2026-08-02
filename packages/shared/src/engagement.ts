import type { LanguageCode } from './domain.js';

/**
 * Phase-2 engagement domain contracts (wave P2b): services marketplace (M8),
 * women & youth programmes (M11), student/NYSC pathways (M12), knowledge
 * base (M14) and search depth (M16). Additive file — existing contracts in
 * domain.ts stay untouched.
 */

// ---------------------------------------------------------------------------
// M8 — Input & Service Marketplace
// ---------------------------------------------------------------------------

export const SUPPLIER_CATEGORIES = [
  'seed',
  'fertiliser',
  'equipment',
  'machinery_hire',
  'cold_storage',
  'labour',
  'insurance'
] as const;
export type SupplierCategory = (typeof SUPPLIER_CATEGORIES)[number];

/** Categories whose bookings reserve a shared resource and cannot overlap. */
export const CONFLICT_CHECKED_CATEGORIES: readonly SupplierCategory[] = [
  'machinery_hire',
  'cold_storage'
];

export const SUPPLIER_VERIFICATION_STATUSES = [
  'unverified',
  'pending',
  'verified',
  'rejected'
] as const;
export type SupplierVerificationStatus = (typeof SUPPLIER_VERIFICATION_STATUSES)[number];

export const PRICING_UNITS = [
  'per_bag',
  'per_day',
  'per_hectare',
  'per_unit',
  'per_trip',
  'flat'
] as const;
export type PricingUnit = (typeof PRICING_UNITS)[number];

export const BOOKING_STATUSES = [
  'requested',
  'quoted',
  'accepted',
  'declined',
  'scheduled',
  'completed',
  'cancelled'
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export interface ServiceSupplier {
  id: string;
  ownerUserId: string;
  businessName: string;
  categories: SupplierCategory[];
  statesCovered: string[];
  lgasCovered: string[];
  verificationStatus: SupplierVerificationStatus;
  averageRating: number;
  ratingCount: number;
  createdAt: string;
}

export interface ServiceOffering {
  id: string;
  supplierId: string;
  category: SupplierCategory;
  title: string;
  description: string;
  priceNaira: number;
  pricingUnit: PricingUnit;
  isActive: boolean;
  createdAt: string;
}

export interface ServiceBooking {
  id: string;
  offeringId: string;
  supplierId: string;
  customerId: string;
  quantity: number;
  /** Set when the supplier quotes; null while only requested. */
  totalNaira?: number;
  scheduledStart: string;
  scheduledEnd: string;
  status: BookingStatus;
  notes?: string;
  createdAt: string;
}

export interface ServiceReview {
  id: string;
  bookingId: string;
  supplierId: string;
  authorId: string;
  /** 1–5. */
  rating: number;
  comment?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// M11 — Women & Youth Programmes
// ---------------------------------------------------------------------------

export const PROGRAMME_TYPES = ['women', 'youth'] as const;
export type ProgrammeType = (typeof PROGRAMME_TYPES)[number];

export const COHORT_STATUSES = ['draft', 'open', 'closed', 'active', 'completed'] as const;
export type CohortStatus = (typeof COHORT_STATUSES)[number];

/** Youth programme age band (inclusive) used by the eligibility check. */
export const YOUTH_MIN_AGE = 18;
export const YOUTH_MAX_AGE = 35;

export interface ProgrammeCohort {
  id: string;
  name: string;
  programmeType: ProgrammeType;
  capacity: number;
  enrolmentOpensAt: string;
  enrolmentClosesAt: string;
  status: CohortStatus;
  moderatorIds: string[];
  createdAt: string;
}

export const PROGRAMME_ENROLMENT_STATUSES = ['enrolled', 'withdrawn', 'completed'] as const;
export type ProgrammeEnrolmentStatus = (typeof PROGRAMME_ENROLMENT_STATUSES)[number];

/**
 * Only self-declared attributes are stored (privacy module: no document
 * verification, minimal personal data).
 */
export interface ProgrammeEnrolment {
  id: string;
  cohortId: string;
  userId: string;
  declaredAge?: number;
  declaredGender?: 'female' | 'male' | 'other';
  status: ProgrammeEnrolmentStatus;
  enrolledAt: string;
}

export interface ProgrammeMilestone {
  id: string;
  cohortId: string;
  title: string;
  sequence: number;
  dueAt?: string;
}

export const MILESTONE_PROGRESS_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type MilestoneProgressStatus = (typeof MILESTONE_PROGRESS_STATUSES)[number];

export interface MilestoneProgress {
  id: string;
  milestoneId: string;
  userId: string;
  status: MilestoneProgressStatus;
  completedAt?: string;
}

export interface RubricCriterion {
  id: string;
  cohortId: string;
  name: string;
  maxScore: number;
}

export interface JudgeAssignment {
  id: string;
  cohortId: string;
  judgeUserId: string;
  assignedAt: string;
}

export interface JudgeScore {
  id: string;
  cohortId: string;
  judgeUserId: string;
  entryUserId: string;
  criterionId: string;
  score: number;
  submittedAt: string;
}

export interface LeaderboardEntry {
  entryUserId: string;
  totalScore: number;
  judgeCount: number;
  averageScore: number;
  rank: number;
}

export interface CohortThread {
  id: string;
  cohortId: string;
  title: string;
  authorId: string;
  replyCount: number;
  createdAt: string;
}

export interface CohortThreadPost {
  id: string;
  threadId: string;
  authorId: string;
  body: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// M12 — Student & NYSC Pathways
// ---------------------------------------------------------------------------

export const PATHWAY_TRACKS = ['student', 'nysc'] as const;
export type PathwayTrack = (typeof PATHWAY_TRACKS)[number];

export interface PathwayTemplate {
  id: string;
  track: PathwayTrack;
  name: string;
  description?: string;
  createdAt: string;
}

export interface PathwayStage {
  id: string;
  templateId: string;
  title: string;
  sequence: number;
  requiredActions: string[];
}

export const PATHWAY_ENROLMENT_STATUSES = ['active', 'completed', 'dropped'] as const;
export type PathwayEnrolmentStatus = (typeof PATHWAY_ENROLMENT_STATUSES)[number];

export interface PathwayEnrolment {
  id: string;
  templateId: string;
  userId: string;
  status: PathwayEnrolmentStatus;
  currentStageId?: string;
  enrolledAt: string;
  completedAt?: string;
}

export const STAGE_PROGRESS_STATUSES = ['pending', 'completed'] as const;
export type StageProgressStatus = (typeof STAGE_PROGRESS_STATUSES)[number];

export interface StageProgress {
  id: string;
  enrolmentId: string;
  stageId: string;
  status: StageProgressStatus;
  /** Completion evidence (link or free-text reference) — required to complete. */
  evidence?: string;
  completedAt?: string;
}

export interface CampusClub {
  id: string;
  name: string;
  institution: string;
  state: string;
  coordinatorUserId: string;
  /** True when the club doubles as an NYSC Community Development Service group. */
  isNyscCdsGroup: boolean;
  memberCount: number;
  createdAt: string;
}

export const CLUB_MEMBER_ROLES = ['member', 'coordinator'] as const;
export type ClubMemberRole = (typeof CLUB_MEMBER_ROLES)[number];

export interface CampusClubMembership {
  id: string;
  clubId: string;
  userId: string;
  role: ClubMemberRole;
  joinedAt: string;
}

// ---------------------------------------------------------------------------
// M14 — Knowledge Base
// ---------------------------------------------------------------------------

export const KNOWLEDGE_FORMATS = ['article', 'video', 'audio', 'pdf'] as const;
export type KnowledgeFormat = (typeof KNOWLEDGE_FORMATS)[number];

export interface KnowledgeResource {
  id: string;
  title: string;
  body: string;
  /** Crop / topic tags. */
  tags: string[];
  language: LanguageCode;
  format: KnowledgeFormat;
  offlineAvailable: boolean;
  viewCount: number;
  publishedAt: string;
}

export interface PodcastEpisode {
  id: string;
  title: string;
  showNotes: string;
  audioUrl: string;
  durationSeconds: number;
  /** Accessibility requirement: every published episode keeps a transcript. */
  transcript?: string;
  publishedAt: string;
}

export const WEBINAR_STATUSES = ['scheduled', 'live', 'completed', 'cancelled'] as const;
export type WebinarStatus = (typeof WEBINAR_STATUSES)[number];

/** Platform default timezone for scheduled events. */
export const DEFAULT_WEBINAR_TIMEZONE = 'Africa/Lagos';

export interface Webinar {
  id: string;
  title: string;
  hostUserId: string;
  /** ISO-8601 start time; interpreted in `timezone`. */
  startsAt: string;
  /** IANA timezone name, defaults to Africa/Lagos. */
  timezone: string;
  recordingUrl?: string;
  status: WebinarStatus;
  createdAt: string;
}

export interface WebinarRegistration {
  id: string;
  webinarId: string;
  userId: string;
  registeredAt: string;
}

// ---------------------------------------------------------------------------
// M16 — Search depth
// ---------------------------------------------------------------------------

export interface SearchQueryEvent {
  id: string;
  query: string;
  occurredAt: string;
}

export interface TrendingQuery {
  query: string;
  /** Decayed occurrence count over the trailing window. */
  score: number;
  occurrences: number;
}
