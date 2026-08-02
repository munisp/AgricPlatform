export const USER_ROLES = [
  'farmer',
  'student',
  'buyer',
  'supplier',
  'chapter_lead',
  'partner',
  'admin'
] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const LANGUAGE_CODES = ['en', 'ha', 'yo', 'ig'] as const;
export type LanguageCode = (typeof LANGUAGE_CODES)[number];

export const KYC_TIERS = ['tier_0', 'tier_1', 'tier_2', 'tier_3'] as const;
export type KycTier = (typeof KYC_TIERS)[number];

export const APPLICATION_STATUSES = [
  'submitted',
  'under_review',
  'successful',
  'unsuccessful',
  'withdrawn'
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const ORDER_STATUSES = [
  'requested',
  'negotiating',
  'confirmed',
  'deposit_paid',
  'in_fulfilment',
  'delivered',
  'completed',
  'disputed',
  'cancelled'
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const NOTIFICATION_CHANNELS = ['in_app', 'sms', 'whatsapp', 'email', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface LocationRef {
  state: string;
  lga: string;
  ward?: string;
  latitude?: number;
  longitude?: number;
}

export interface User {
  id: string;
  phone: string;
  email?: string;
  fullName: string;
  roles: UserRole[];
  preferredLanguage: LanguageCode;
  kycTier: KycTier;
  isVerified: boolean;
  createdAt: string;
  lastActiveAt?: string;
}

export interface Profile {
  userId: string;
  location: LocationRef;
  farmingInterests: string[];
  valueChains: string[];
  bio?: string;
  farmSizeHectares?: number;
  yearsExperience?: number;
  completionScore: number;
  badges: string[];
}

export interface ConsentRecord {
  id: string;
  userId: string;
  purpose: string;
  granted: boolean;
  source: string;
  grantedAt: string;
  revokedAt?: string;
}

export interface Course {
  id: string;
  title: string;
  category: string;
  level: 'beginner' | 'intermediate' | 'advanced';
  durationMinutes: number;
  language: LanguageCode;
  enrolmentCount: number;
  offlineAvailable: boolean;
}

export interface Enrolment {
  id: string;
  courseId: string;
  userId: string;
  progressPercent: number;
  status: 'enrolled' | 'in_progress' | 'completed';
  enrolledAt: string;
  completedAt?: string;
}

export interface Certificate {
  id: string;
  userId: string;
  courseId: string;
  verificationCode: string;
  issuedAt: string;
  verificationUrl: string;
}

export interface ForumTopic {
  id: string;
  title: string;
  category: string;
  authorId: string;
  state?: string;
  crop?: string;
  replyCount: number;
  createdAt: string;
}

export interface MentorRequest {
  id: string;
  userId: string;
  crop: string;
  state: string;
  challenge: string;
  status: 'requested' | 'matched' | 'closed';
  createdAt: string;
}

export interface Opportunity {
  id: string;
  title: string;
  type: 'grant' | 'loan' | 'programme' | 'job' | 'internship' | 'competition' | 'equipment' | 'land';
  description: string;
  states: string[];
  valueChains: string[];
  eligibility: string[];
  deadline: string;
  partnerId?: string;
  isActive: boolean;
}

export interface OpportunityApplication {
  id: string;
  opportunityId: string;
  userId: string;
  status: ApplicationStatus;
  submittedAt: string;
  notes?: string;
}

export interface Chapter {
  id: string;
  name: string;
  level: 'national' | 'state' | 'lga' | 'ward';
  parentId?: string;
  state: string;
  lga?: string;
  leadUserId?: string;
  memberCount: number;
  active: boolean;
}

export interface ChapterEvent {
  id: string;
  chapterId: string;
  title: string;
  type: 'meeting' | 'training' | 'field_visit' | 'programme';
  startsAt: string;
  location: string;
  rsvpCount: number;
  attendanceCount: number;
}

export interface AdvisoryItem {
  id: string;
  kind: 'crop_calendar' | 'pest_alert' | 'weather' | 'price' | 'guide';
  title: string;
  summary: string;
  state?: string;
  crop?: string;
  severity?: 'info' | 'warning' | 'critical';
  publishedAt: string;
}

export interface MarketplaceListing {
  id: string;
  sellerId: string;
  kind: 'produce' | 'input' | 'service' | 'equipment' | 'storage' | 'transport';
  title: string;
  crop?: string;
  quantity: number;
  unit: string;
  priceNaira: number;
  location: LocationRef;
  harvestDate?: string;
  isActive: boolean;
}

export interface Order {
  id: string;
  listingId: string;
  buyerId: string;
  sellerId: string;
  quantity: number;
  totalNaira: number;
  status: OrderStatus;
  escrowRequired: boolean;
  createdAt: string;
}

export interface CreditProfile {
  userId: string;
  score: number;
  trainingSignals: number;
  transactionSignals: number;
  productionSignals: number;
  documentCount: number;
  improvementActions: string[];
}

export interface VaultDocument {
  id: string;
  userId: string;
  kind: 'national_id' | 'land_title' | 'farm_photo' | 'certificate' | 'business_plan' | 'utility_bill';
  fileName: string;
  status: 'uploaded' | 'verified' | 'rejected';
  uploadedAt: string;
}

export interface NotificationPreference {
  userId: string;
  channel: NotificationChannel;
  enabled: boolean;
}

export interface NotificationMessage {
  id: string;
  userId: string;
  channel: NotificationChannel;
  title: string;
  body: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'read';
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  /** Hash of the previous audit event in the tamper-evident chain (additive). */
  prevHash?: string;
  /** sha256 over the canonical event payload + prevHash (additive). */
  hash?: string;
  /** Correlates the audit event with the HTTP request that caused it (additive). */
  requestId?: string;
}

/**
 * Consistent API error envelope produced by the API exception filter.
 * `requestId` is additive: older clients ignore it (observability wave).
 */
export interface ApiErrorResponse {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
  requestId?: string;
}

export interface PlatformMetric {
  key: string;
  label: string;
  value: number;
  unit?: string;
  trend?: number;
}

export interface IntegrationStatus {
  provider: string;
  capability: string;
  driver: 'stub' | 'sandbox' | 'production';
  configured: boolean;
  healthy: boolean;
  notes?: string;
}

export interface ApiListResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiItemResponse<T> {
  data: T;
}
